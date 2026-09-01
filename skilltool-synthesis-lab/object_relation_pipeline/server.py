from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
LAB_ROOT = ROOT.parent
WEB_ROOT = ROOT / "web"
RUNS_ROOT = ROOT / "runs"
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from object_relation_pipeline.pipeline.contracts import STAGE_ORDER  # noqa: E402
from object_relation_pipeline.pipeline.modeling import build_models  # noqa: E402
from object_relation_pipeline.pipeline.runner import PipelineRunner, resolve_stage  # noqa: E402
from object_relation_pipeline.pipeline.storage import create_state, list_runs, load_state, new_run_id, save_state  # noqa: E402


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def local_model_config() -> dict[str, Any]:
    config = read_json(LAB_ROOT / "data/model_config.example.json")
    local = LAB_ROOT / "data/model_config.local.json"
    if local.is_file():
        config.update(read_json(local))
    return config


def request_model_config(value: dict[str, Any]) -> dict[str, Any]:
    merged = local_model_config()
    requested_url = str(value.get("base_url") or "").strip().rstrip("/")
    local_url = str(merged.get("base_url") or "").strip().rstrip("/")
    if requested_url and requested_url != local_url:
        merged.pop("api_key", None)
        merged.pop("api_key_env", None)
    merged.update({key: item for key, item in value.items() if item is not None and item != ""})
    return merged


def public_model_config() -> dict[str, Any]:
    config = local_model_config()
    return {
        key: value for key, value in config.items()
        if key not in {"api_key", "api_key_env"}
    } | {"api_key_configured": bool(config.get("api_key") or config.get("api_key_env"))}


def scenario_catalog() -> list[dict[str, str]]:
    results = []
    for path in sorted((LAB_ROOT / "data/scenarios").glob("*.txt")):
        results.append({
            "scenario_id": path.stem,
            "name": path.stem.replace("_", " "),
            "content": path.read_text(encoding="utf-8").strip(),
        })
    return results


def profile_catalog() -> list[dict[str, str]]:
    results = []
    for path in sorted((LAB_ROOT / "data/profiles").glob("*.txt")):
        results.append({
            "profile_id": path.stem,
            "name": path.stem.replace("_", " "),
            "content": path.read_text(encoding="utf-8").strip(),
        })
    return results


def bootstrap_payload() -> dict[str, Any]:
    scenarios = scenario_catalog()
    profiles = profile_catalog()
    return {
        "profile": profiles[0]["content"],
        "scenario": scenarios[0]["content"],
        "profiles": profiles,
        "scenarios": scenarios,
        "stage_order": list(STAGE_ORDER),
        "stage_labels": {
            "stage1_1_input_validation": "1.1 输入检查",
            "stage1_2_context_binding_planning": "1.2 上下文绑定规划",
            "stage1_3_p0_local_synthesis": "1.3 局部 P0 候选生成",
            "stage1_4_p0_cross_context_synthesis": "1.4 跨场景 P0 候选生成",
            "stage1_5_p0_complexity_validation": "1.5 P0 m→n 复杂度审计",
            "stage1_6_p0_portfolio_finalization": "1.6 P0 去重与组合定稿",
            "stage2_1_relation_extraction": "2.1 m→n 关系抽取",
            "stage2_2_object_clustering": "2.2 Object Set 聚类",
            "stage3_1_relation_sampling": "3.1 k→1 关系采样",
            "stage3_2_p1_task_generation": "3.2 P1 任务生成",
            "stage3_3_p1_task_validation": "3.3 P1 任务验证",
            "stage4_1_skill_generation": "4.1 Skill 候选生成",
            "stage4_2_artifact_finalization": "4.2 Skill 校验与产物",
        },
        "model_config": public_model_config(),
        "sampling_defaults": {
            "seed": 20260827,
            "target_count": 8,
            "candidate_multiplier": 3,
            "k_min": 1,
            "k_max": 3,
            "mode": "constrained",
        },
        "p0_defaults": {
            "target_count": 24,
            "cross_scenario_ratio": 0.3,
            "max_bindings": 16,
            "bridge_tasks_per_group": 2,
            "min_complexity_score": 0.65,
        },
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "ObjectRelationSkillLab/1.0"

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
        if length <= 0 or length > 8_000_000:
            raise ValueError("request body must be between 1 byte and 8 MB")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("request body must be an object")
        return value

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/health":
            self._json_response({"ok": True, "service": "object-relation-skill-pipeline"})
            return
        if path == "/api/bootstrap":
            self._json_response(bootstrap_payload())
            return
        if path == "/api/runs":
            self._json_response({"runs": list_runs(RUNS_ROOT)})
            return
        if path.startswith("/api/runs/"):
            run_id = path.removeprefix("/api/runs/")
            try:
                self._json_response(load_state(RUNS_ROOT, run_id))
            except ValueError as error:
                self._json_response({"error": "invalid_request", "message": str(error)}, HTTPStatus.BAD_REQUEST)
            except FileNotFoundError:
                self._json_response({"error": "not_found", "message": "run not found"}, HTTPStatus.NOT_FOUND)
            return
        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/api/run":
            self._json_response({"error": "not_found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            body = self._read_json()
            run_id = str(body.get("run_id") or "")
            mode = str(body.get("mode") or "mock")
            config = request_model_config(body.get("model_config") or {})
            if run_id:
                state = load_state(RUNS_ROOT, run_id)
                if state.get("model_mode") != mode:
                    raise ValueError("model mode cannot change during a run")
                if "stage3_1_relation_sampling" not in (state.get("completed_stages") or []) and isinstance(body.get("sampling"), dict):
                    state.setdefault("options", {}).setdefault("sampling", {}).update(body["sampling"])
                if "stage1_2_context_binding_planning" not in (state.get("completed_stages") or []) and isinstance(body.get("p0"), dict):
                    state.setdefault("options", {}).setdefault("p0", {}).update(body["p0"])
                save_state(RUNS_ROOT / state["run_id"], state)
            else:
                base_model, relation_model, model_name = build_models(mode, config)
                sampling = body.get("sampling") or {}
                state = create_state(
                    run_id=new_run_id(model_name),
                    profile=str(body.get("profile") or "").strip() or None,
                    scenario=str(body.get("scenario") or "").strip() or None,
                    profiles=body.get("profiles") if isinstance(body.get("profiles"), list) else None,
                    scenarios=body.get("scenarios") if isinstance(body.get("scenarios"), list) else None,
                    bindings=body.get("bindings") if isinstance(body.get("bindings"), list) else None,
                    model_mode=mode,
                    model_name=model_name,
                    options={"sampling": sampling, "p0": body.get("p0") or {}},
                )
                run_dir = RUNS_ROOT / state["run_id"]
                run_dir.mkdir(parents=True, exist_ok=False)
                save_state(run_dir, state)
                runner = PipelineRunner(runs_root=RUNS_ROOT, base_model=base_model, relation_model=relation_model)
                result = runner.run_interval(
                    state,
                    from_stage=resolve_stage(str(body.get("from_stage") or STAGE_ORDER[0])),
                    to_stage=resolve_stage(str(body.get("to_stage") or STAGE_ORDER[-1])),
                )
                self._json_response(result)
                return
            base_model, relation_model, _ = build_models(mode, config)
            runner = PipelineRunner(runs_root=RUNS_ROOT, base_model=base_model, relation_model=relation_model)
            result = runner.run_interval(
                state,
                from_stage=resolve_stage(str(body.get("from_stage") or state.get("next_stage") or STAGE_ORDER[-1])),
                to_stage=resolve_stage(str(body.get("to_stage") or state.get("next_stage") or STAGE_ORDER[-1])),
            )
            self._json_response(result)
        except (ValueError, json.JSONDecodeError) as error:
            self._json_response({"error": "invalid_request", "message": str(error)}, HTTPStatus.BAD_REQUEST)
        except FileNotFoundError:
            self._json_response({"error": "not_found", "message": "run not found"}, HTTPStatus.NOT_FOUND)
        except Exception as error:  # pragma: no cover
            self._json_response({"error": "pipeline_failed", "message": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

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
        sys.stderr.write(f"[object-relation-lab] {format_string % args}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Object-relation Skill synthesis Web lab")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    args = parser.parse_args()
    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Object Relation Skill Lab: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
