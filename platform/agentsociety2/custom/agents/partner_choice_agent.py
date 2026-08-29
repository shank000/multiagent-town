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
        if not observed or not observed.get("roundOpen") or observed.get("alreadySubmitted"):
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
            actual_model = str(getattr(response, "model", None) or self._model_name or "")
            if actual_model != model_id:
                raise RuntimeError(f"actual model {actual_model!r} differs from frozen modelId {model_id!r}")
            request_id = str(getattr(response, "id", None) or "")
            if not request_id:
                raise RuntimeError("LLM response did not provide a request ID")
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
            }
            result_ctx, result_text = await self.ask_env(
                {"variables": variables},
                "Call submit_partner_choice with every value from ctx['variables'] exactly once.",
                readonly=False,
                template_mode=True,
            )
            return canonical_json({"result": result_ctx, "message": result_text})
        return f"choice parsing exhausted; environment fallback will apply: {last_error}"

    @staticmethod
    def _decision_messages(profile: Mapping[str, Any], observation: Mapping[str, Any]) -> list[dict[str, str]]:
        system = (
            "Choose exactly one social partner. Use only the stable self profile and the supplied "
            "candidate observation. Return JSON with chosenId and a concise rationale."
        )
        user = canonical_json({"selfProfile": dict(profile), "observation": dict(observation)})
        return [{"role": "system", "content": system}, {"role": "user", "content": user}]

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
