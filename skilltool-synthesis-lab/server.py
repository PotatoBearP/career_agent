from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import replace
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
WEB_ROOT = ROOT / "web"
RUNS_ROOT = ROOT / "runs"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.artifacts import persist_run_snapshot
from pipeline.direct_synthesis import finalize_direct_result
from pipeline.mock_model import MockSynthesisModel
from pipeline.model_api import ModelConfig, OpenAICompatibleModel
from pipeline.synthesis import PipelineError, STAGE_ORDER, SynthesisPipeline, dedupe_task_pool


RUN_ID_PATTERN = re.compile(r"^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def local_model_config() -> dict[str, Any]:
    config = read_json(ROOT / "data/model_config.example.json")
    local_path = ROOT / "data/model_config.local.json"
    if local_path.is_file():
        config.update(read_json(local_path))
    return config


def public_model_config() -> dict[str, Any]:
    config = local_model_config()
    return {
        key: value
        for key, value in config.items()
        if key not in {"api_key", "api_key_env"}
    } | {"api_key_configured": bool(ModelConfig.from_dict(config).api_key)}


def request_model_config(value: dict[str, Any]) -> ModelConfig:
    merged = local_model_config()
    requested_base_url = str(value.get("base_url") or "").strip().rstrip("/")
    local_base_url = str(merged.get("base_url") or "").strip().rstrip("/")
    if requested_base_url and requested_base_url != local_base_url:
        merged.pop("api_key", None)
        merged.pop("api_key_env", None)
    merged.update({key: item for key, item in value.items() if item is not None and item != ""})
    return ModelConfig.from_dict(merged)


def reject_corrupted_text(value: Any) -> None:
    if isinstance(value, str) and re.search(r"\?{4,}", value):
        raise ValueError("input contains long runs of '?' and appears to be encoding-corrupted")
    if isinstance(value, dict):
        for item in value.values():
            reject_corrupted_text(item)
    elif isinstance(value, list):
        for item in value:
            reject_corrupted_text(item)


def scenario_catalog() -> list[dict[str, str]]:
    definitions = [
        (
            "industry_opportunity_discovery",
            "职业方向探索与真实机会验证",
            "从工作活动、真实岗位与个人证据出发缩小职业方向。",
        ),
        (
            "job_application_material_preparation",
            "岗位材料准备",
            "整理基础简历，并按目标岗位准备针对性的投递材料。",
        ),
        (
            "network_application_tracking",
            "人脉申请追踪",
            "寻找公开联系与内推入口，维护投递状态和后续跟进。",
        ),
    ]
    return [
        {
            "scenario_id": scenario_id,
            "name": name,
            "description": description,
            "content": read_text(ROOT / f"data/scenarios/{scenario_id}.txt"),
        }
        for scenario_id, name, description in definitions
    ]


def bootstrap_payload() -> dict[str, Any]:
    scenarios = scenario_catalog()
    return {
        "profile": read_text(ROOT / "data/profiles/computer_ai_graduate.txt"),
        "scenario": scenarios[0]["content"],
        "default_scenario_id": scenarios[0]["scenario_id"],
        "scenarios": scenarios,
        "model_config": public_model_config(),
        "skilltool_template": read_json(ROOT / "data/templates/skilltool_template.json"),
        "tool_catalog": read_json(ROOT / "data/tools/project_tools.json"),
        "pipeline": [
            {"id": "profile", "label": "直接输入 + 画像 / 场景参考", "kind": "input"},
            {"id": "inputs", "label": "输入检验", "kind": "quality"},
            {"id": "tasks", "label": "自然任务池", "kind": "reasoning"},
            {"id": "composition", "label": "任务 + 普通工具 / Harness Tool", "kind": "generation"},
            {"id": "render", "label": "按 ref 生成", "kind": "generation"},
            {"id": "validation", "label": "产物校验", "kind": "quality"},
            {"id": "skilltools", "label": "SkillTool + Harness 产物", "kind": "output"},
        ],
    }


def run_path(runs_root: Path, run_id: str) -> Path:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise ValueError("invalid run id")
    return runs_root / run_id / "run.json"


def read_run(runs_root: Path, run_id: str) -> dict[str, Any]:
    path = run_path(runs_root, run_id)
    if not path.is_file():
        raise FileNotFoundError(run_id)
    value = read_json(path)
    if value.get("run_id") != run_id:
        raise ValueError("run id does not match stored result")
    return value


def list_runs(runs_root: Path, limit: int = 50) -> list[dict[str, Any]]:
    if not runs_root.exists():
        return []
    results: list[dict[str, Any]] = []
    directories = sorted(
        (item for item in runs_root.iterdir() if item.is_dir()),
        key=lambda item: item.name,
        reverse=True,
    )
    for directory in directories:
        try:
            value = read_run(runs_root, directory.name)
        except (FileNotFoundError, ValueError, json.JSONDecodeError, OSError):
            continue
        results.append(
            {
                "run_id": directory.name,
                "model_mode": value.get("model_mode"),
                "model_name": value.get("model_name") or value.get("model_mode"),
                "run_status": value.get("run_status") or "completed",
                "next_stage": value.get("next_stage"),
                "summary": value.get("summary") or {},
                "modified_at": directory.joinpath("run.json").stat().st_mtime,
            }
        )
        if len(results) >= limit:
            break
    return results


def update_run(runs_root: Path, run_id: str, value: dict[str, Any]) -> dict[str, Any]:
    path = run_path(runs_root, run_id)
    if not path.is_file():
        raise FileNotFoundError(run_id)
    if value.get("run_id") != run_id:
        raise ValueError("run_id cannot be changed")
    if not isinstance(value.get("inputs"), dict):
        raise ValueError("inputs must be an object")
    if not isinstance(value.get("final_candidates"), list):
        raise ValueError("final_candidates must be an array")
    for field in ("summary", "task_map", "quality"):
        if not isinstance(value.get(field), dict):
            raise ValueError(f"{field} must be an object")
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
    return value


def dedupe_result_task_pool(value: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    result = deepcopy(value)
    if not isinstance(result.get("task_map"), dict):
        raise ValueError("task_map must be an object")
    if not isinstance(result["task_map"].get("tasks"), list) or not result["task_map"]["tasks"]:
        raise ValueError("task pool is empty")
    completed = {str(item.get("stage")) for item in result.get("stages") or [] if isinstance(item, dict)}
    downstream = completed & {"candidate_synthesis", "dedupe_merge", "quality_gate"}
    if downstream:
        raise ValueError("task pool cannot be changed after SkillTool synthesis has started")

    before_map = deepcopy(result["task_map"])
    result["task_map"], report = dedupe_task_pool(result["task_map"])
    task_map = result["task_map"]
    prior_iterations = [int(item.get("iteration") or 0) for item in task_map.get("iterations") or [] if isinstance(item, dict)]
    iteration = max(prior_iterations, default=0) + 1
    retained_ids = [item.get("task_id") for item in task_map.get("tasks") or []]
    removed_ids = set(report.get("removed_task_ids") or [])
    checkpoint = {
        "iteration": iteration,
        "direction": "deduplication",
        "status": "completed",
        "proposed_tasks": deepcopy(before_map.get("tasks") or []),
        "accepted_tasks": deepcopy(task_map.get("tasks") or []),
        "removed_tasks": [deepcopy(item) for item in before_map.get("tasks") or [] if str(item.get("task_id")) in removed_ids],
        "retained_tasks": deepcopy(task_map.get("tasks") or []),
        "input_pool": deepcopy(task_map.get("input_pool") or []),
        "output_pool": deepcopy(task_map.get("output_pool") or []),
        "coverage": deepcopy(task_map.get("coverage") or []),
        "dedupe_decisions": deepcopy(report.get("decisions") or []),
        "iteration_control": {"continue": False, "reason": "独立语义去重迭代已完成"},
        "iteration_limit_reached": False,
        "model_trace": {"operation": "deterministic_semantic_task_deduplication", "parsed_output": report},
    }
    task_map.setdefault("iteration_checkpoints", []).append(checkpoint)
    task_map.setdefault("iterations", []).append({
        "iteration": iteration,
        "direction": "deduplication",
        "proposed_task_ids": [item.get("task_id") for item in before_map.get("tasks") or []],
        "retained_task_ids": retained_ids,
        "removed_task_ids": sorted(removed_ids),
        "inferred_outputs": deepcopy(task_map.get("output_pool") or []),
        "continue_requested": False,
        "continue_reason": "独立语义去重迭代已完成",
    })
    summary = result.setdefault("summary", {})
    summary["task_iterations"] = len(task_map.get("iterations") or [])
    summary["tasks"] = len(result["task_map"].get("tasks") or [])
    inferred_outputs = result["task_map"].get("inferred_outputs")
    summary["inferred_outputs"] = (
        len(inferred_outputs)
        if isinstance(inferred_outputs, list)
        else sum(len(item.get("outputs") or []) for item in result["task_map"].get("tasks") or [])
    )
    result["last_task_pool_dedupe"] = report
    return result, report


def iterate_result_task_pool(
    value: dict[str, Any], direction: str, model: Any
) -> tuple[dict[str, Any], dict[str, Any]]:
    if direction == "deduplication":
        result, report = dedupe_result_task_pool(value)
        action = {
            "direction": direction,
            "iteration": (result.get("task_map") or {}).get("iterations", [{}])[-1].get("iteration"),
            "duration_ms": 0,
            "task_count": (result.get("summary") or {}).get("tasks", 0),
            "report": report,
        }
        result.setdefault("task_iteration_actions", []).append(action)
        return result, action
    if direction not in {"extension", "decomposition"}:
        raise ValueError("direction must be extension, decomposition, or deduplication")
    result = deepcopy(value)
    if result.get("next_stage") != "candidate_synthesis":
        raise ValueError("task iteration requires an initialized task pool before SkillTool synthesis")
    if (result.get("candidate_generation") or {}).get("raw_candidates"):
        raise ValueError("task pool cannot be changed after SkillTool synthesis has started")
    checkpoints = (result.get("task_map") or {}).get("iteration_checkpoints") or []
    next_iteration = max(
        (int(item.get("iteration") or 0) for item in checkpoints if isinstance(item, dict)),
        default=1,
    ) + 1
    working = deepcopy(result)
    working["stages"] = [
        item for item in result.get("stages") or [] if item.get("stage") == "input_validation"
    ]
    working["synthesis_trace"] = [
        item for item in result.get("synthesis_trace") or [] if item.get("stage") == "input_validation"
    ]
    working["next_stage"] = "task_synthesis"
    working["run_status"] = "in_progress"
    pipeline = SynthesisPipeline(
        model,
        runs_root=None,
        task_iteration_start=next_iteration,
        task_iteration_limit=next_iteration,
        task_iteration_directions=(direction,),
    )
    pipeline.advance(working, "task_synthesis")
    stage_meta = working["stages"][-1]
    result["task_map"] = working["task_map"]
    result["input_validation"] = working["input_validation"]
    for key in ("task_iterations", "tasks", "inferred_outputs"):
        result["summary"][key] = working["summary"][key]
    action = {
        "direction": direction,
        "iteration": next_iteration,
        "duration_ms": int(stage_meta.get("duration_ms") or 0),
        "task_count": result["summary"]["tasks"],
    }
    result.setdefault("task_iteration_actions", []).append(action)
    timing = result.setdefault("timing", {})
    durations = timing.setdefault("stage_duration_ms", {})
    durations[f"task_iteration_{next_iteration}_{direction}"] = action["duration_ms"]
    timing["total_duration_ms"] = sum(int(value or 0) for value in durations.values())
    return result, action


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
        if length <= 0 or length > 8_000_000:
            raise ValueError("request body must be between 1 byte and 8 MB")
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
            self._json_response({"runs": list_runs(RUNS_ROOT)})
            return
        if path.startswith("/api/runs/"):
            run_id = path.removeprefix("/api/runs/")
            try:
                self._json_response(read_run(RUNS_ROOT, run_id))
            except ValueError as error:
                self._json_response({"error": "invalid_request", "message": str(error)}, HTTPStatus.BAD_REQUEST)
            except FileNotFoundError:
                self._json_response({"error": "not_found", "message": "run not found"}, HTTPStatus.NOT_FOUND)
            return
        self._serve_static(path)

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/api/runs/"):
            self._json_response({"error": "not_found"}, HTTPStatus.NOT_FOUND)
            return
        run_id = path.removeprefix("/api/runs/")
        try:
            value = self._read_json()
            self._json_response(update_run(RUNS_ROOT, run_id, value))
        except (ValueError, json.JSONDecodeError) as error:
            self._json_response({"error": "invalid_request", "message": str(error)}, HTTPStatus.BAD_REQUEST)
        except FileNotFoundError:
            self._json_response({"error": "not_found", "message": "run not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path not in {"/api/synthesize-stage", "/api/iterate-task-pool", "/api/direct-skilltools"}:
            self._json_response({"error": "not_found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            body = self._read_json()
            if path == "/api/direct-skilltools":
                run_id = str(body.get("run_id") or "")
                persist = bool(body.get("persist", True))
                if persist:
                    if not run_id:
                        raise ValueError("run_id is required when persist is true")
                    result = read_run(RUNS_ROOT, run_id)
                else:
                    result = body.get("result")
                    if not isinstance(result, dict):
                        raise ValueError("result is required when persist is false")
                if not (result.get("task_map") or {}).get("tasks"):
                    raise ValueError("final task pool is empty")
                mode = str(body.get("mode") or result.get("model_mode") or "mock")
                if result.get("model_mode") != mode:
                    raise ValueError("model mode cannot change during a run")
                if mode not in {"mock", "api"}:
                    raise ValueError("mode must be mock or api")
                model = MockSynthesisModel() if mode == "mock" else OpenAICompatibleModel(
                    request_model_config(body.get("model_config") or {})
                )
                pipeline = SynthesisPipeline(model, runs_root=RUNS_ROOT)
                if result.get("next_stage") != "candidate_synthesis":
                    raise ValueError("direct SkillTool synthesis requires a confirmed final task pool")
                pipeline.advance(result, "candidate_synthesis")
                finalize_direct_result(
                    result,
                    generator="configured_model" if mode == "api" else "mock_model",
                )
                if persist:
                    persist_run_snapshot(RUNS_ROOT, result["run_id"], result)
                self._json_response(result)
                return
            if path == "/api/iterate-task-pool":
                run_id = str(body.get("run_id") or "")
                persist = bool(body.get("persist", bool(run_id)))
                if persist:
                    if not run_id:
                        raise ValueError("run_id is required when persist is true")
                    result = read_run(RUNS_ROOT, run_id)
                else:
                    result = body.get("result")
                    if not isinstance(result, dict):
                        raise ValueError("result is required for an unsaved task pool")
                    if run_id and result.get("run_id") != run_id:
                        raise ValueError("supplied result does not match run_id")
                direction = str(body.get("direction") or "")
                mode = str(body.get("mode") or result.get("model_mode") or "mock")
                if result.get("model_mode") != mode:
                    raise ValueError("model mode cannot change during a run")
                if mode not in {"mock", "api"}:
                    raise ValueError("mode must be mock or api")
                model = MockSynthesisModel() if mode == "mock" else OpenAICompatibleModel(
                    request_model_config(body.get("model_config") or {})
                )
                result, iteration = iterate_result_task_pool(result, direction, model)
                if persist:
                    persist_run_snapshot(RUNS_ROOT, run_id, result)
                self._json_response({"result": result, "iteration": iteration})
                return
            for input_name in ("profile", "scenario"):
                if input_name in body:
                    reject_corrupted_text(body[input_name])
            mode = str(body.get("mode") or "mock")
            if mode == "mock":
                model = MockSynthesisModel()
            elif mode == "api":
                model = OpenAICompatibleModel(
                    request_model_config(body.get("model_config") or {})
                )
            else:
                raise ValueError("mode must be mock or api")
            stage = str(body.get("stage") or "")
            pipeline = SynthesisPipeline(
                model,
                runs_root=RUNS_ROOT,
                task_iteration_limit=1,
                task_iteration_directions=("initialization",),
            )
            if path == "/api/synthesize-stage":
                if stage not in {"input_validation", "task_synthesis"}:
                    raise ValueError("the staged endpoint only supports task-pool initialization")
                run_id = str(body.get("run_id") or "")
                persist = bool(body.get("persist", True))
                if run_id:
                    supplied_result = body.get("result")
                    if not persist and isinstance(supplied_result, dict):
                        result = supplied_result
                        if result.get("run_id") != run_id:
                            raise ValueError("supplied result does not match run_id")
                    else:
                        result = read_run(RUNS_ROOT, run_id)
                    if result.get("model_mode") != mode:
                        raise ValueError("model mode cannot change during a staged run")
                else:
                    if stage != STAGE_ORDER[0]:
                        raise ValueError(f"a staged run must start with {STAGE_ORDER[0]}")
                    result = pipeline.create_result(
                        profile=body.get("profile") or {},
                        scenario=body.get("scenario") or {},
                        model_mode=mode,
                    )
                    if persist:
                        result["run_directory"] = str(RUNS_ROOT / result["run_id"])
                pipeline.advance(result, stage)
                if persist:
                    persist_run_snapshot(RUNS_ROOT, result["run_id"], result)
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
        except FileNotFoundError:
            self._json_response(
                {"error": "not_found", "message": "staged run not found"},
                HTTPStatus.NOT_FOUND,
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
    parser.add_argument("--run-api-sample", action="store_true", help="run the sample with data/model_config.local.json and exit")
    parser.add_argument("--resume-api-run", metavar="RUN_ID", help="resume a saved API run from its next stage")
    parser.add_argument("--api-model", help="override the model name from local config for an API run")
    parser.add_argument("--timeout-seconds", type=int, help="override one model request timeout; default comes from model config")
    parser.add_argument("--recheck-run", metavar="RUN_ID", help="re-run deterministic reconciliation and quality for a saved run")
    args = parser.parse_args()
    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    if args.run_sample:
        data = bootstrap_payload()
        result = SynthesisPipeline(MockSynthesisModel(), runs_root=RUNS_ROOT).run(
            profile=data["profile"],
            scenario=data["scenario"],
            persist=True,
            model_mode="mock",
        )
        print(json.dumps({"run_id": result["run_id"], "summary": result["summary"], "run_directory": result["run_directory"]}, ensure_ascii=False, indent=2))
        return
    if args.run_api_sample:
        data = bootstrap_payload()
        config = ModelConfig.from_dict(local_model_config())
        model = OpenAICompatibleModel(replace(
            config,
            model=args.api_model or config.model,
            timeout_seconds=args.timeout_seconds or config.timeout_seconds,
        ))
        def report_progress(stage: str, status: str) -> None:
            print(f"[{status}] {stage}", flush=True)
        result = SynthesisPipeline(model, runs_root=RUNS_ROOT).run(
            profile=data["profile"],
            scenario=data["scenario"],
            persist=True,
            model_mode="api",
            progress_callback=report_progress,
        )
        print(json.dumps({"run_id": result["run_id"], "summary": result["summary"], "quality": result["quality"]["rubric_summary"], "run_directory": result["run_directory"]}, ensure_ascii=False, indent=2))
        return
    if args.resume_api_run:
        if not RUN_ID_PATTERN.fullmatch(args.resume_api_run):
            raise ValueError("invalid run id")
        run_file = RUNS_ROOT / args.resume_api_run / "run.json"
        if not run_file.is_file():
            raise FileNotFoundError(f"run not found: {args.resume_api_run}")
        config = ModelConfig.from_dict(local_model_config())
        model = OpenAICompatibleModel(replace(
            config,
            model=args.api_model or config.model,
            timeout_seconds=args.timeout_seconds or config.timeout_seconds,
        ))
        def report_resume_progress(stage: str, status: str) -> None:
            print(f"[{status}] {stage}", flush=True)
        result = SynthesisPipeline(model, runs_root=RUNS_ROOT).resume(
            read_json(run_file), persist=True, progress_callback=report_resume_progress
        )
        print(json.dumps({"run_id": result["run_id"], "summary": result["summary"], "quality": result["quality"]["rubric_summary"], "run_directory": result["run_directory"]}, ensure_ascii=False, indent=2))
        return
    if args.recheck_run:
        if not RUN_ID_PATTERN.fullmatch(args.recheck_run):
            raise ValueError("invalid run id")
        run_file = RUNS_ROOT / args.recheck_run / "run.json"
        if not run_file.is_file():
            raise FileNotFoundError(f"run not found: {args.recheck_run}")
        result = SynthesisPipeline(MockSynthesisModel(), runs_root=RUNS_ROOT).recheck_quality(
            read_json(run_file), persist=True
        )
        print(json.dumps({"run_id": result["run_id"], "summary": result["summary"], "quality": result["quality"]["rubric_summary"], "recheck": result["postprocessing_recheck"], "run_directory": result["run_directory"]}, ensure_ascii=False, indent=2))
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
