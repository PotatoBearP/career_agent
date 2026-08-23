from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.artifacts import build_artifact_preview, persist_run_snapshot
from pipeline.input_validation import ordinary_tool_output_assets, validate_inputs
from pipeline.quality import evaluate_portfolio


def main(run_id: str) -> None:
    run_file = ROOT / "runs" / run_id / "run.json"
    payload = json.loads(run_file.read_text(encoding="utf-8"))
    inputs = payload["inputs"]
    current_inventory = (payload.get("input_validation") or {}).get("input_inventory") or []
    base_inventory = [item for item in current_inventory if (item.get("producer") or {}).get("stage") != "task_synthesis"]
    additional = ordinary_tool_output_assets(payload["task_map"]["tasks"], base_inventory)
    validation = validate_inputs(inputs["profile"], inputs["scenario"], additional)
    validation["validation_pass"] = "post_task_reconciliation"
    validation["additional_assets"] = [item["asset_id"] for item in additional]
    payload["input_validation"] = validation
    payload["task_map"]["input_inventory"] = validation["input_inventory"]
    quality = evaluate_portfolio(
        payload["final_candidates"],
        payload["task_map"],
        tool_catalog=payload.get("tool_catalog"),
        scenario=inputs["scenario"],
    )
    payload["quality"] = quality
    report_by_skill = {item["skill_id"]: item for item in quality["candidate_reports"]}
    eligible = [item for item in payload["final_candidates"] if report_by_skill.get(item.get("skill_id"), {}).get("passed")]
    payload["artifacts"] = [build_artifact_preview(item) for item in eligible]
    payload["summary"]["eligible_artifacts"] = len(payload["artifacts"])
    payload["summary"]["quality_status"] = quality["status"]
    payload["summary"]["failed_rubrics"] = quality["rubric_summary"]["failed"]
    payload["summary"]["warning_rubrics"] = quality["rubric_summary"]["warnings"]
    for trace in payload.get("synthesis_trace") or []:
        if trace.get("stage") == "input_validation":
            trace["operation"] = "deterministic_input_validation_with_task_reconciliation"
            trace["parsed_output"] = validation
        elif trace.get("stage") == "task_synthesis":
            trace["parsed_output"] = payload["task_map"]
        elif trace.get("stage") == "quality_gate":
            trace["operation"] = "deterministic_quality_gate_after_input_reconciliation"
            trace["parsed_output"] = quality
            trace["status"] = "completed" if quality["passed"] else "needs_revision"
    for stage in payload.get("stages") or []:
        if stage.get("stage") == "input_validation":
            stage["status"] = "completed" if validation["passed"] else "needs_revision"
        elif stage.get("stage") == "quality_gate":
            stage["status"] = "completed" if quality["passed"] else "needs_revision"
    persist_run_snapshot(ROOT / "runs", run_id, payload)
    print(json.dumps({
        "run_id": run_id,
        "additional_assets": validation["additional_assets"],
        "input_validation": validation["status"],
        "quality": quality["status"],
        "rubrics": quality["rubric_summary"],
        "artifacts": len(payload["artifacts"]),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: reconcile_run_inputs.py <run_id>")
    main(sys.argv[1])
