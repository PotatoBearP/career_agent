from __future__ import annotations

import argparse
import json
import mimetypes
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
RUNS_ROOT = ROOT / "runs"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.mock_model import MockSynthesisModel
from pipeline.model_api import ModelConfig, OpenAICompatibleModel
from pipeline.synthesis import PipelineError, SynthesisPipeline


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def bootstrap_payload() -> dict[str, Any]:
    return {
        "profile": read_json(ROOT / "data/profiles/computer_ai_graduate.json"),
        "state": read_json(ROOT / "data/states/exploration_state.json"),
        "scenario": read_json(ROOT / "data/scenarios/industry_opportunity_discovery.json"),
        "model_config": read_json(ROOT / "data/model_config.example.json"),
        "skilltool_template": read_json(ROOT / "data/templates/skilltool_template.json"),
        "tool_catalog": read_json(ROOT / "data/tools/project_tools.json"),
        "pipeline": [
            {"id": "profile", "label": "画像 + 独立场景", "kind": "input"},
            {"id": "needs", "label": "需求分析", "kind": "reasoning"},
            {"id": "tasks", "label": "任务 / 场景合成", "kind": "reasoning"},
            {"id": "candidates", "label": "Skill candidates", "kind": "generation"},
            {"id": "dedupe", "label": "降重 / 合并", "kind": "quality"},
            {"id": "skilltools", "label": "SkillTool 产物", "kind": "output"},
        ],
    }


class LabHandler(BaseHTTPRequestHandler):
    server_version = "SkillToolSynthesisLab/1.0"

    def _json_response(self, value: Any, status: int = 200) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 2_000_000:
            raise ValueError("request body must be between 1 byte and 2 MB")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        return value

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/health":
            self._json_response({"ok": True, "service": "skilltool-synthesis-lab"})
            return
        if path == "/api/bootstrap":
            self._json_response(bootstrap_payload())
            return
        if path == "/api/runs":
            runs = sorted(
                (item.name for item in RUNS_ROOT.iterdir() if item.is_dir()),
                reverse=True,
            )[:20]
            self._json_response({"runs": runs})
            return
        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/api/synthesize":
            self._json_response({"error": "not_found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            body = self._read_json()
            mode = str(body.get("mode") or "mock")
            if mode == "mock":
                model = MockSynthesisModel()
            elif mode == "api":
                model = OpenAICompatibleModel(
                    ModelConfig.from_dict(body.get("model_config") or {})
                )
            else:
                raise ValueError("mode must be mock or api")
            pipeline = SynthesisPipeline(model, runs_root=RUNS_ROOT)
            result = pipeline.run(
                profile=body.get("profile") or {},
                state=body.get("state") or {},
                scenario=body.get("scenario") or {},
                persist=bool(body.get("persist", True)),
                model_mode=mode,
            )
            self._json_response(result)
        except (ValueError, json.JSONDecodeError, PipelineError) as error:
            self._json_response(
                {
                    "error": "invalid_request" if not isinstance(error, PipelineError) else "pipeline_failed",
                    "message": str(error),
                    **({"stage": error.stage} if isinstance(error, PipelineError) else {}),
                },
                HTTPStatus.BAD_REQUEST,
            )
        except Exception as error:  # pragma: no cover - defensive server boundary
            self._json_response(
                {"error": "internal_error", "message": str(error)},
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    def _serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in {"", "/"} else request_path.lstrip("/")
        candidate = (WEB_ROOT / relative).resolve()
        try:
            candidate.relative_to(WEB_ROOT.resolve())
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        payload = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") or content_type == "application/javascript" else content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format_string: str, *args: Any) -> None:
        sys.stderr.write(f"[skilltool-lab] {self.address_string()} {format_string % args}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Standalone SkillTool synthesis lab")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--run-sample", action="store_true", help="run the offline sample and exit")
    args = parser.parse_args()
    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    if args.run_sample:
        data = bootstrap_payload()
        result = SynthesisPipeline(MockSynthesisModel(), runs_root=RUNS_ROOT).run(
            profile=data["profile"],
            state=data["state"],
            scenario=data["scenario"],
            persist=True,
            model_mode="mock",
        )
        print(json.dumps({"run_id": result["run_id"], "summary": result["summary"], "run_directory": result["run_directory"]}, ensure_ascii=False, indent=2))
        return
    server = ThreadingHTTPServer((args.host, args.port), LabHandler)
    print(f"SkillTool Synthesis Lab: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
