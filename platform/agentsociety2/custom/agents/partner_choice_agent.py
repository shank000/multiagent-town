"""Fresh-completion AgentSociety agent for the confirmatory partner-choice study."""

from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
from pathlib import Path
from typing import Any, Mapping

from agentsociety2.agent.base import AgentBase


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def tagged_hash(value: Any) -> str:
    return "sha256:" + sha256(canonical_json(value).encode("utf-8")).hexdigest()


class PartnerChoiceAgent(AgentBase):
    """One-shot decision agent with no memory, TODO, workspace, or ReAct context."""

    @classmethod
    def init_description(cls) -> str:
        return (
            "PartnerChoiceAgent requires a stable profile and decision config containing "
            "modelId, temperature, topP, maxTokens, and maxAttempts. Each choice uses one "
            "fresh completion over only the stable profile and controlled observation."
        )

    async def to_workspace(self, workspace_path: Path) -> None:
        workspace_path = Path(workspace_path)
        meta_path = workspace_path / "AGENT.json"
        current = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
        current.update({
            "agent_class": self.__class__.__name__,
            "agent_id": self.id,
            "id": self.id,
            "name": self.name,
            "profile": self.get_profile(),
            "step_count": self._step_count,
            "current_time": self._current_time.isoformat() if self._current_time else None,
            "visible_skills": [],
            "activated_skills": [],
        })
        meta_path.write_text(
            json.dumps(current, ensure_ascii=False, sort_keys=True, indent=2),
            encoding="utf-8",
        )

    async def ask(self, message: str, readonly: bool = True, *, t: datetime | None = None) -> str:
        del readonly, t
        response = await self.acompletion(
            [{"role": "user", "content": str(message)}],
            stream=False,
        )
        return self._response_text(response)

    async def step(self, tick: int, t: datetime) -> str:
        del tick
        self._step_count += 1
        self._current_time = t
        observation_ctx, observation_text = await self.ask_env(
            {"variables": {"agent_id": self.id}},
            "Call observe_partner_round using agent_id from ctx['variables'].",
            readonly=True,
            template_mode=True,
        )
        observed = self._find_observation(observation_ctx)
        if observed is None:
            try:
                observed = self._find_observation(json.loads(observation_text))
            except (TypeError, json.JSONDecodeError):
                observed = None
        if not observed or not observed.get("roundOpen"):
            return "partner round is not awaiting this agent"

        observation = observed["observation"]
        decision = dict(self._config.get("decision") or {})
        model_id = str(decision.get("modelId") or "")
        if not model_id or model_id == "ONLINE_WORKSPACE_REQUIRED":
            raise RuntimeError("decision.modelId must be frozen to the actual online model")
        temperature = float(decision["temperature"])
        top_p = float(decision["topP"])
        max_tokens = int(decision["maxTokens"])
        max_attempts = int(decision["maxAttempts"])
        messages = self._decision_messages(self.get_profile(), observation)
        prompt_hash = tagged_hash(messages)
        candidate_ids = {str(item["id"]) for item in observation["candidates"]}
        chosen_id = str(observed.get("chosenId") or "")
        choice_result: dict[str, Any] = {}
        if not observed.get("alreadySubmitted"):
            last_error = ""
            for attempt in range(1, max_attempts + 1):
                response = await self.acompletion(
                    messages,
                    stream=False,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    response_format={"type": "json_object"},
                )
                raw_response = self._response_text(response)
                try:
                    parsed = json.loads(raw_response)
                    chosen_id = str(parsed["chosenId"])
                    rationale = str(parsed.get("rationale") or "")[:1000]
                except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                    last_error = f"invalid JSON response: {exc}"
                    continue
                if chosen_id not in candidate_ids:
                    last_error = "chosenId is outside the controlled candidate set"
                    continue
                actual_model, request_id = self._response_identity(response, model_id)
                usage = self._usage(response)
                variables = {
                    "agent_id": self.id,
                    "chosen_id": int(chosen_id),
                    "rationale": rationale,
                    "raw_response": raw_response,
                    "model_id": actual_model,
                    "request_id": request_id,
                    "rendered_prompt_hash": prompt_hash,
                    "temperature": temperature,
                    "top_p": top_p,
                    "max_tokens": max_tokens,
                    "attempt_count": attempt,
                    **usage,
                }
                result_ctx, result_text = await self.ask_env(
                    {"variables": variables},
                    "Call submit_partner_choice with every value from ctx['variables'] exactly once.",
                    readonly=False,
                    template_mode=True,
                )
                choice_result = {"result": result_ctx, "message": result_text}
                break
            else:
                return f"choice parsing exhausted; environment fallback will apply: {last_error}"

        if observed.get("interactionRequired") and not observed.get("interactionSubmitted"):
            interaction_result = await self._submit_interaction(observation, chosen_id)
            return canonical_json({"choice": choice_result, "interaction": interaction_result})
        return canonical_json({"choice": choice_result})

    async def _submit_interaction(self, observation: Mapping[str, Any], chosen_id: str) -> dict[str, Any]:
        interaction = dict(self._config.get("interaction") or {})
        model_id = str(interaction.get("modelId") or "")
        if not model_id or model_id == "ONLINE_WORKSPACE_REQUIRED":
            raise RuntimeError("interaction.modelId must be frozen to the actual online model")
        max_attempts = int(interaction["maxAttempts"])
        max_tokens = int(interaction["maxTokens"])
        messages = self._interaction_messages(self.get_profile(), observation, chosen_id)
        prompt_hash = tagged_hash(messages)
        last_error = ""
        for attempt in range(1, max_attempts + 1):
            response = await self.acompletion(
                messages,
                stream=False,
                temperature=0.2,
                top_p=1.0,
                max_tokens=max_tokens,
                response_format={"type": "json_object"},
            )
            raw_response = self._response_text(response)
            try:
                parsed = json.loads(raw_response)
                summary = str(parsed["summary"]).strip()[:1000]
                if not summary:
                    raise ValueError("summary is empty")
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                last_error = f"invalid interaction JSON: {exc}"
                continue
            actual_model, request_id = self._response_identity(response, model_id)
            variables = {
                "agent_id": self.id,
                "summary": summary,
                "raw_response": raw_response,
                "model_id": actual_model,
                "request_id": request_id,
                "rendered_prompt_hash": prompt_hash,
                "attempt_count": attempt,
                **self._usage(response),
            }
            result_ctx, result_text = await self.ask_env(
                {"variables": variables},
                "Call submit_interaction_summary with every value from ctx['variables'] exactly once.",
                readonly=False,
                template_mode=True,
            )
            return {"result": result_ctx, "message": result_text}
        return {"error": f"interaction parsing exhausted; deterministic fallback will be audited: {last_error}"}

    @staticmethod
    def _decision_messages(profile: Mapping[str, Any], observation: Mapping[str, Any]) -> list[dict[str, str]]:
        system = (
            "Choose exactly one social partner. Use only the stable self profile and the supplied "
            "candidate observation. Return JSON with chosenId and a concise rationale."
        )
        user = canonical_json({"selfProfile": dict(profile), "observation": dict(observation)})
        return [{"role": "system", "content": system}, {"role": "user", "content": user}]

    @staticmethod
    def _interaction_messages(
        profile: Mapping[str, Any], observation: Mapping[str, Any], chosen_id: str
    ) -> list[dict[str, str]]:
        candidate = next(
            (dict(item) for item in observation.get("candidates", []) if str(item.get("id")) == chosen_id),
            {"id": chosen_id},
        )
        system = (
            "Render one short, plausible completed interaction between the chooser and selected partner. "
            "Use only the stable chooser profile and selected candidate observation. Return JSON with summary."
        )
        user = canonical_json({"selfProfile": dict(profile), "selectedCandidate": candidate})
        return [{"role": "system", "content": system}, {"role": "user", "content": user}]

    def _response_identity(self, response: Any, frozen_model: str) -> tuple[str, str]:
        actual_model = str(getattr(response, "model", None) or self._model_name or "")
        if actual_model != frozen_model:
            raise RuntimeError(f"actual model {actual_model!r} differs from frozen modelId {frozen_model!r}")
        request_id = str(getattr(response, "id", None) or "")
        if not request_id:
            raise RuntimeError("LLM response did not provide a request ID")
        return actual_model, request_id

    @staticmethod
    def _usage(response: Any) -> dict[str, int]:
        usage = getattr(response, "usage", None)
        def value(name: str) -> int:
            raw = getattr(usage, name, 0) if usage is not None else 0
            return max(0, int(raw or 0))
        return {
            "input_tokens": value("prompt_tokens"),
            "output_tokens": value("completion_tokens"),
            "total_tokens": value("total_tokens"),
        }

    @staticmethod
    def _response_text(response: Any) -> str:
        choices = getattr(response, "choices", None) or []
        if not choices:
            return ""
        message = getattr(choices[0], "message", None)
        return str(getattr(message, "content", None) or "")

    @classmethod
    def _find_observation(cls, value: Any) -> dict[str, Any] | None:
        if isinstance(value, Mapping):
            if "roundOpen" in value and ("observation" in value or not value.get("roundOpen")):
                return dict(value)
            for nested in value.values():
                found = cls._find_observation(nested)
                if found is not None:
                    return found
        elif isinstance(value, list):
            for nested in value:
                found = cls._find_observation(nested)
                if found is not None:
                    return found
        return None
