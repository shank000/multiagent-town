from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from types import SimpleNamespace
import unittest

os.environ.setdefault("AGENTSOCIETY_LLM_API_KEY", "offline-agent-test")

from custom.agents.partner_choice_agent import PartnerChoiceAgent


def response(request_id: str, model: str, payload: dict, prompt: int, completion: int):
    return SimpleNamespace(
        id=request_id,
        model=model,
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))],
        usage=SimpleNamespace(
            prompt_tokens=prompt,
            completion_tokens=completion,
            total_tokens=prompt + completion,
        ),
    )


class PartnerChoiceAgentTest(unittest.TestCase):
    def test_controlled_real_response_shape_audits_choice_and_interaction_calls(self) -> None:
        async def run() -> None:
            model = "online/formal-model-v1"
            agent = PartnerChoiceAgent()
            agent._id = 1
            agent._profile = {"id": 1, "name": "Participant 01", "occupation": "archivist"}
            agent._model_name = model
            agent._step_count = 0
            agent._config = {
                "decision": {
                    "modelId": model, "temperature": 0.2, "topP": 1,
                    "maxTokens": 256, "maxAttempts": 2,
                },
                "interaction": {
                    "modelId": model, "maxTokens": 192, "maxAttempts": 2,
                },
            }
            observation = {
                "schemaVersion": "partner-choice.observation/v1",
                "day": 1,
                "roundId": "day-001-1930",
                "chooserId": "1",
                "candidates": [{"id": "2", "name": "Participant 02", "history": []}],
            }
            completions = iter([
                response("req-choice", model, {"chosenId": "2", "rationale": "shared interest"}, 20, 5),
                response("req-interaction", model, {"summary": "They exchanged a brief greeting."}, 12, 8),
            ])
            submitted: list[dict] = []

            async def fake_completion(*_args, **_kwargs):
                return next(completions)

            async def fake_env(ctx, instruction, **_kwargs):
                if "observe_partner_round" in instruction:
                    return ({"value": {
                        "ok": True, "roundOpen": True, "alreadySubmitted": False,
                        "interactionRequired": True, "interactionSubmitted": False,
                        "chosenId": None, "observation": observation,
                    }}, "observed")
                submitted.append(dict(ctx["variables"]))
                return ({"ok": True}, "submitted")

            agent.acompletion = fake_completion
            agent.ask_env = fake_env
            result = await agent.step(60, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
            self.assertIn("interaction", result)
            self.assertEqual(len(submitted), 2)
            choice, interaction = submitted
            self.assertEqual(choice["request_id"], "req-choice")
            self.assertEqual(choice["total_tokens"], 25)
            self.assertTrue(choice["rendered_prompt_hash"].startswith("sha256:"))
            self.assertEqual(interaction["request_id"], "req-interaction")
            self.assertEqual(interaction["total_tokens"], 20)
            self.assertEqual(json.loads(interaction["raw_response"])["summary"], interaction["summary"])

        asyncio.run(run())

    def test_none_interaction_prompt_contains_no_hidden_history_or_treatment_label(self) -> None:
        messages = PartnerChoiceAgent._interaction_messages(
            {"id": 1, "name": "Participant 01"},
            {"candidates": [{"id": "2", "name": "Participant 02", "history": []}]},
            "2",
        )
        rendered = json.dumps(messages)
        self.assertNotIn("historyMode", rendered)
        self.assertNotIn("giftExchange", rendered)
        self.assertNotIn("conditionId", rendered)


if __name__ == "__main__":
    unittest.main()
