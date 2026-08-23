from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.artifacts import persist_run_snapshot
from pipeline.model_api import ModelConfig, OpenAICompatibleModel
from pipeline.synthesis import STAGE_ORDER, SynthesisPipeline


def main() -> int:
    parser = argparse.ArgumentParser(description="Legacy multi-stage SkillTool synthesis with dedupe and quality gate. Prefer run_direct_skilltool_batch.py for ref-style direct synthesis.")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()

    run_path = ROOT / "runs" / args.run_id / "run.json"
    result = json.loads(run_path.read_text(encoding="utf-8"))
    if not (result.get("task_map") or {}).get("tasks"):
        raise SystemExit("saved run has no final task pool")
    next_stage = result.get("next_stage")
    if next_stage not in {"candidate_synthesis", "dedupe_merge", "quality_gate"}:
        raise SystemExit(f"run cannot continue from next_stage={next_stage!r}")

    api_key = getpass.getpass("API key (not stored): ")
    pipeline = SynthesisPipeline(
        OpenAICompatibleModel(ModelConfig(
            base_url=args.base_url,
            model=args.model,
            api_key=api_key,
            temperature=0.2,
            max_tokens=24000,
            timeout_seconds=args.timeout,
        )),
        runs_root=ROOT / "runs",
    )
    try:
        start = STAGE_ORDER.index(str(result["next_stage"]))
        for stage in STAGE_ORDER[start:]:
            pipeline.advance(result, stage)
            persist_run_snapshot(ROOT / "runs", result["run_id"], result)
    except Exception as error:
        persist_run_snapshot(ROOT / "runs", result["run_id"], result)
        print(json.dumps({
            "run_id": result["run_id"],
            "status": "failed",
            "stage": getattr(error, "stage", result.get("next_stage")),
            "error": str(error),
            "completed_candidates": len((result.get("candidate_generation") or {}).get("raw_candidates") or []),
        }, ensure_ascii=False))
        return 1

    print(json.dumps({
        "run_id": result["run_id"],
        "status": result["run_status"],
        "skilltools": result["summary"]["skilltools"],
        "eligible_artifacts": result["summary"]["eligible_artifacts"],
        "quality_status": result["summary"]["quality_status"],
        "quality_rubrics": result["quality"]["rubric_summary"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
