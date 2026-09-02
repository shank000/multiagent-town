"""Actual SDK lifecycle gate backed by a local OpenAI-compatible HTTP fixture."""

from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
from threading import Thread
from typing import Any


MODEL = "formal-fixture-model"
ROOT = Path(__file__).resolve().parents[1]


class FixtureHandler(BaseHTTPRequestHandler):
    request_count = 0

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_POST(self) -> None:  # noqa: N802 - HTTP handler API
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        FixtureHandler.request_count += 1
        text = "\n".join(str(item.get("content") or "") for item in body.get("messages", []))
        if "# Code Generation Task" in text:
            instruction = ""
            if "<instruction>" in text and "</instruction>" in text:
                instruction = text.split("<instruction>", 1)[1].split("</instruction>", 1)[0]
            if "submit_interaction_summary" in instruction:
                content = (
                    'response = await modules["PartnerChoiceEnv"].submit_interaction_summary(**ctx["variables"])\n'
                    'results["value"] = response\n'
                    'print("Recorded the audited interaction summary.")\n'
                    'results["status"] = "success"'
                )
            elif "submit_partner_choice" in instruction:
                content = (
                    'response = await modules["PartnerChoiceEnv"].submit_partner_choice(**ctx["variables"])\n'
                    'results["value"] = response\n'
                    'print("Recorded the audited partner choice.")\n'
                    'results["status"] = "success"'
                )
            elif "statistics" in instruction.lower():
                content = (
                    'response = await modules["PartnerChoiceEnv"].get_round_status()\n'
                    'results["statistics"] = {"PartnerChoiceEnv": response}\n'
                    'print("Collected partner round statistics.")\n'
                    'results["status"] = "success"'
                )
            elif "observe" in instruction.lower():
                content = (
                    'variables = ctx.get("variables", {})\n'
                    'agent_id = variables.get("agent_id", ctx.get("agent_id", ctx.get("id")))\n'
                    'response = await modules["PartnerChoiceEnv"].observe_partner_round(agent_id)\n'
                    'results["observations"] = {"PartnerChoiceEnv": response}\n'
                    'print("Observed the partner round.")\n'
                    'results["status"] = "success"'
                )
            else:
                content = 'print("Unsupported fixture instruction.")\nresults["status"] = "fail"'
        elif '"selectedCandidate"' in text:
            content = json.dumps({"summary": "The selected pair exchanged a brief, friendly greeting."})
        else:
            candidate_id = "2"
            try:
                user = json.loads(str(body["messages"][-1]["content"]))
                candidate_id = str(user["observation"]["candidates"][0]["id"])
            except Exception:
                pass
            content = json.dumps({"chosenId": candidate_id, "rationale": "first controlled candidate"})
        payload = {
            "id": f"fixture-request-{FixtureHandler.request_count}",
            "object": "chat.completion",
            "created": 1,
            "model": MODEL,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28},
        }
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


async def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}/v1"
        os.environ["AGENTSOCIETY_LLM_API_KEY"] = "fixture-key-not-persisted"
        os.environ["AGENTSOCIETY_LLM_API_BASE"] = base
        os.environ["AGENTSOCIETY_LLM_MODEL"] = MODEL
        os.environ["AGENTSOCIETY_CODER_LLM_API_KEY"] = "fixture-key-not-persisted"
        os.environ["AGENTSOCIETY_CODER_LLM_API_BASE"] = base
        os.environ["AGENTSOCIETY_CODER_LLM_MODEL"] = MODEL
        os.environ["WORKSPACE_PATH"] = str(ROOT)
        os.environ["AGENTSOCIETY_LLM_RAY_MAX_WORKERS"] = "2"
        os.environ["AGENTSOCIETY_BATCH_SIZE"] = "2"

        from execution.preflight import PreflightError, preflight_run
        from execution.run_formal import execute_selected_run
        from execution.stage_bundle import build_execution_bundle

        bundle = build_execution_bundle(ROOT, "online-smoke", MODEL)
        selected = bundle["runs"][0]
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary) / "actual-sdk-run"
            try:
                preflight_run(bundle, ROOT, selected["protocol"]["runId"], run_dir)
            except PreflightError as exc:
                if "SDK_RAY_UNAVAILABLE" not in str(exc):
                    raise
                print(json.dumps({
                    "formalGatePassed": False,
                    "hardGate": "SDK_RAY_UNAVAILABLE",
                    "choices": 0,
                    "interactions": 0,
                    "httpRequests": 0,
                    "replayBytes": 0,
                }, sort_keys=True))
                return
            report = await execute_selected_run(bundle, selected, ROOT, run_dir)
            assert report["formalGatePassed"], report
            assert report["completion"]["completedChoices"] == 2
            assert report["completion"]["completedInteractions"] == 2
            assert report["fallback"]["rate"] == 0
            assert report["storageBytes"]["replay"] > 0
            assert (run_dir / "SOCIETY.json").is_file()
            assert (run_dir / "quality-report.json").is_file()
            serialized = (run_dir / "quality-report.json").read_text(encoding="utf-8")
            assert "fixture-key-not-persisted" not in serialized
            print(json.dumps({
                "formalGatePassed": report["formalGatePassed"],
                "choices": report["completion"]["completedChoices"],
                "interactions": report["completion"]["completedInteractions"],
                "httpRequests": FixtureHandler.request_count,
                "replayBytes": report["storageBytes"]["replay"],
            }, sort_keys=True))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    asyncio.run(main())
