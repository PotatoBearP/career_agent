from __future__ import annotations

import argparse
import getpass
import json
import sys
from copy import deepcopy
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.artifacts import persist_run, persist_run_snapshot
from pipeline.model_api import ModelConfig, OpenAICompatibleModel
from pipeline.synthesis import SynthesisPipeline


def main() -> int:
    parser = argparse.ArgumentParser(description="Continue a saved task pool with decomposition and extension rounds.")
    parser.add_argument("--source-run-id", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    source_path = ROOT / "runs" / args.source_run_id / "run.json"
    source = json.loads(source_path.read_text(encoding="utf-8"))
    if not (source.get("task_map") or {}).get("tasks"):
        raise SystemExit("source run has no task pool")

    api_key = getpass.getpass("API key (not stored): ")
    config = ModelConfig(
        base_url=args.base_url,
        model=args.model,
        api_key=api_key,
        temperature=0.2,
        max_tokens=24000,
        timeout_seconds=args.timeout,
    )
    pipeline = SynthesisPipeline(
        OpenAICompatibleModel(config),
        runs_root=ROOT / "runs",
        task_iteration_limit=3,
        task_iteration_start=2,
        task_iteration_directions=("discovery", "decomposition", "extension"),
    )
    result = pipeline.create_result(
        profile=source["inputs"]["profile"],
        scenario=source["inputs"]["scenario"],
        model_mode="api",
    )
    result["source_run_id"] = args.source_run_id
    result["run_directory"] = str(ROOT / "runs" / result["run_id"])
    persist_run(ROOT / "runs", result["run_id"], result)
    try:
        pipeline.advance(result, "input_validation")
        seed_map = deepcopy(source["task_map"])
        for record in seed_map.get("iterations") or []:
            record.setdefault("direction", "discovery")
        for checkpoint in seed_map.get("iteration_checkpoints") or []:
            checkpoint.setdefault("direction", "discovery")
        for task in seed_map.get("tasks") or []:
            if int(task.get("iteration") or 1) == 1:
                task.setdefault("evolution_direction", "discovery")
                task.setdefault("source_task_ids", [])
        result["task_map"] = seed_map
        result["summary"]["task_iterations"] = len(seed_map.get("iterations") or [])
        result["summary"]["tasks"] = len(seed_map.get("tasks") or [])
        result["summary"]["inferred_outputs"] = len(seed_map.get("output_pool") or [])
        persist_run_snapshot(ROOT / "runs", result["run_id"], result)
        pipeline.advance(result, "task_synthesis")
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
        "source_run_id": args.source_run_id,
        "status": "task_evolution_completed",
        "iterations": result["summary"]["task_iterations"],
        "tasks": result["summary"]["tasks"],
        "rounds": [
            {
                "iteration": item.get("iteration"),
                "direction": item.get("direction"),
                "accepted": len(item.get("accepted_tasks") or []),
            }
            for item in result["task_map"].get("iteration_checkpoints") or []
        ],
        "run_directory": result["run_directory"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
