from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.artifacts import persist_run_snapshot
from pipeline.quality import evaluate_portfolio


def migrate_run(run_file: Path) -> dict[str, object]:
    payload = json.loads(run_file.read_text(encoding="utf-8"))
    quality = evaluate_portfolio(
        payload.get("final_candidates") or [],
        payload.get("task_map") or {"tasks": []},
        tool_catalog=payload.get("tool_catalog"),
        scenario=(payload.get("inputs") or {}).get("scenario"),
    )
    payload["quality"] = quality
    summary = payload.setdefault("summary", {})
    summary.pop("quality_score", None)
    summary["quality_status"] = quality["status"]
    summary["failed_rubrics"] = quality["rubric_summary"]["failed"]
    summary["warning_rubrics"] = quality["rubric_summary"]["warnings"]
    for trace in payload.get("synthesis_trace") or []:
        if trace.get("stage") == "quality_gate":
            trace["parsed_output"] = quality
            trace["operation"] = "deterministic_rubric_gate"
    persist_run_snapshot(run_file.parents[1], payload["run_id"], payload)
    return {
        "run_id": payload["run_id"],
        "status": quality["status"],
        **quality["rubric_summary"],
    }


def main() -> None:
    runs_root = ROOT / "runs"
    results = [
        migrate_run(run_file)
        for run_file in sorted(runs_root.glob("run-*/run.json"))
    ]
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
