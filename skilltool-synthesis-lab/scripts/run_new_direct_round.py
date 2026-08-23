from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.artifacts import persist_run, persist_run_snapshot
from pipeline.direct_synthesis import finalize_direct_result
from pipeline.model_api import ModelConfig, OpenAICompatibleModel
from pipeline.synthesis import SynthesisPipeline


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def report(event: str, **details: Any) -> None:
    print(
        json.dumps(
            {"time": datetime.now().astimezone().isoformat(timespec="seconds"), "event": event, **details},
            ensure_ascii=False,
        ),
        flush=True,
    )


def candidate_is_direct_ready(candidate: dict[str, Any]) -> bool:
    child_tools = set(map(str, candidate.get("child_tools") or []))
    selected_tools = {
        str(item.get("tool_name"))
        for item in candidate.get("tool_selection") or []
        if isinstance(item, dict) and item.get("tool_name")
    }
    return bool(
        candidate.get("skill_name")
        and candidate.get("tool_name")
        and (candidate.get("operating_model") or {}).get("workflow")
        and child_tools == selected_tools
    )


def prepare_direct_retry(result: dict[str, Any]) -> list[str]:
    if result.get("direct_synthesis", {}).get("enabled"):
        return []
    stages = result.get("stages") or []
    if not any(item.get("stage") == "candidate_synthesis" for item in stages):
        return []
    candidates = list((result.get("candidate_generation") or {}).get("raw_candidates") or [])
    invalid = [item for item in candidates if not candidate_is_direct_ready(item)]
    if not invalid:
        return []
    generation = result["candidate_generation"]
    generation["raw_candidates"] = [item for item in candidates if candidate_is_direct_ready(item)]
    generation["raw_count"] = len(generation["raw_candidates"])
    result["stages"] = [item for item in stages if item.get("stage") != "candidate_synthesis"]
    result["synthesis_trace"] = [
        item for item in result.get("synthesis_trace") or []
        if item.get("stage") != "candidate_synthesis"
    ]
    result["next_stage"] = "candidate_synthesis"
    return [str(item.get("skill_id") or item.get("task_ids") or "unknown") for item in invalid]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a fresh task synthesis round and direct SkillTool composition with the configured API."
    )
    parser.add_argument("--config", type=Path, default=ROOT / "data/model_config.local.json")
    parser.add_argument("--profile", type=Path, default=ROOT / "data/profiles/computer_ai_graduate.txt")
    parser.add_argument("--scenario", type=Path, default=ROOT / "data/scenarios/industry_opportunity_discovery.txt")
    parser.add_argument("--resume", help="Resume an existing run ID from its next incomplete stage.")
    args = parser.parse_args()

    model = OpenAICompatibleModel(ModelConfig.from_dict(load_json(args.config)))
    pipeline = SynthesisPipeline(
        model,
        runs_root=ROOT / "runs",
        task_iteration_limit=3,
        task_iteration_start=1,
        task_iteration_directions=("initialization", "extension", "decomposition"),
    )
    if args.resume:
        run_file = ROOT / "runs" / args.resume / "run.json"
        modified_at = datetime.fromtimestamp(run_file.stat().st_mtime).astimezone()
        result = load_json(run_file)
        started_at = datetime.fromisoformat(result["timing"]["started_at"])
        if not result.get("direct_synthesis", {}).get("enabled"):
            result["timing"]["prior_elapsed_ms"] = max(
                int(result["timing"].get("total_duration_ms") or 0),
                round((modified_at - started_at).total_seconds() * 1000),
            )
        result.pop("error", None)
        result["run_status"] = "in_progress"
        retry_candidates = prepare_direct_retry(result)
        report(
            "run_resumed",
            run_id=result["run_id"],
            completed_candidates=result["candidate_generation"].get("raw_count", 0),
            retry_candidates=retry_candidates,
        )
    else:
        result = pipeline.create_result(
            profile=read_text(args.profile),
            scenario=read_text(args.scenario),
            model_mode="api",
        )
        result["run_directory"] = str(ROOT / "runs" / result["run_id"])
        persist_run(ROOT / "runs", result["run_id"], result)
        report("run_started", run_id=result["run_id"], model=result["model_name"])

    try:
        completed_stages = {item.get("stage") for item in result.get("stages") or []}
        for stage in ("input_validation", "task_synthesis", "candidate_synthesis"):
            if stage in completed_stages:
                continue
            report("stage_started", stage=stage)
            pipeline.advance(result, stage)
            persist_run_snapshot(ROOT / "runs", result["run_id"], result)
            stage_meta = result["stages"][-1]
            report(
                "stage_completed",
                stage=stage,
                duration_ms=stage_meta.get("duration_ms", 0),
                tasks=result["summary"].get("tasks", 0),
                candidates=result["candidate_generation"].get("raw_count", 0),
            )
        finalize_direct_result(result, generator="configured_model")
        persist_run_snapshot(ROOT / "runs", result["run_id"], result)
    except Exception as error:
        result["run_status"] = "failed"
        result["error"] = {"stage": getattr(error, "stage", result.get("next_stage")), "message": str(error)}
        persist_run_snapshot(ROOT / "runs", result["run_id"], result)
        report("run_failed", run_id=result["run_id"], error=str(error))
        return 1

    report(
        "run_completed",
        run_id=result["run_id"],
        tasks=result["summary"]["tasks"],
        skilltools=result["summary"]["skilltools"],
        harness_tools=result["direct_synthesis"]["validation"]["harness_tool_count"],
        total_duration_ms=result["timing"]["total_duration_ms"],
        run_directory=result["run_directory"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
