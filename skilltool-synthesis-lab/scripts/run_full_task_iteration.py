from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.artifacts import persist_run, persist_run_snapshot
from pipeline.model_api import ModelConfig, OpenAICompatibleModel
from pipeline.synthesis import SynthesisPipeline, dedupe_task_pool_iteration


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run initialization, extension, decomposition, and deduplication in that order."
    )
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()

    api_key = getpass.getpass("API key (not stored): ")
    model = OpenAICompatibleModel(ModelConfig(
        base_url=args.base_url,
        model=args.model,
        api_key=api_key,
        temperature=0.2,
        max_tokens=24000,
        timeout_seconds=args.timeout,
    ))
    pipeline = SynthesisPipeline(
        model,
        runs_root=ROOT / "runs",
        task_iteration_limit=3,
        task_iteration_start=1,
        task_iteration_directions=("initialization", "extension", "decomposition"),
    )
    result = pipeline.create_result(
        profile=read_text(ROOT / "data/profiles/computer_ai_graduate.txt"),
        scenario=read_text(ROOT / "data/scenarios/industry_opportunity_discovery.txt"),
        model_mode="api",
    )
    result["run_directory"] = str(ROOT / "runs" / result["run_id"])
    persist_run(ROOT / "runs", result["run_id"], result)

    try:
        pipeline.advance(result, "input_validation")
        persist_run_snapshot(ROOT / "runs", result["run_id"], result)
        pipeline.advance(result, "task_synthesis")
        persist_run_snapshot(ROOT / "runs", result["run_id"], result)

        result["task_map"], dedupe_report = dedupe_task_pool_iteration(result["task_map"])
        result["last_task_pool_dedupe"] = dedupe_report
        result["summary"]["task_iterations"] = len(result["task_map"].get("iterations") or [])
        result["summary"]["tasks"] = len(result["task_map"].get("tasks") or [])
        result["summary"]["inferred_outputs"] = len(result["task_map"].get("output_pool") or [])
        persist_run_snapshot(ROOT / "runs", result["run_id"], result)
    except Exception as error:
        stage = getattr(error, "stage", "task_synthesis")
        result["run_status"] = "failed"
        result["error"] = {"stage": stage, "message": str(error)}
        result["synthesis_trace"].append({
            "stage": stage,
            "status": "failed",
            "model_exchange": getattr(pipeline.model, "last_trace", {}) or {},
            "error": str(error),
        })
        persist_run_snapshot(ROOT / "runs", result["run_id"], result)
        print(json.dumps({"run_id": result["run_id"], "status": "failed", "error": str(error)}, ensure_ascii=False))
        return 1

    print(json.dumps({
        "run_id": result["run_id"],
        "status": "full_task_iteration_completed",
        "tasks": result["summary"]["tasks"],
        "input_pool": len(result["task_map"].get("input_pool") or []),
        "output_pool": len(result["task_map"].get("output_pool") or []),
        "rounds": [
            {
                "iteration": item.get("iteration"),
                "direction": item.get("direction"),
                "proposed": len(item.get("proposed_tasks") or []),
                "accepted": len(item.get("accepted_tasks") or []),
                "removed": len(item.get("removed_tasks") or []),
            }
            for item in result["task_map"].get("iteration_checkpoints") or []
        ],
        "dedupe": result["last_task_pool_dedupe"],
        "run_directory": result["run_directory"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
