from __future__ import annotations

from copy import deepcopy
from typing import Any

from .contracts import StageContext, StageExecution
from .contexts import relation_context_pack, scenario_text
from .prompts import RELATION_SYSTEM_PROMPT, p1_generation_prompt, p1_validation_prompt
from .stage3_2_p1_task_generation import normalize_generated_task
from .storage import write_value


STAGE_NAME = "stage3_3_p1_task_validation"
EXPECTED_RUBRICS = {
    "relation_fidelity",
    "input_sufficiency",
    "output_derivability",
    "scenario_alignment",
    "natural_user_request",
    "business_value",
    "scope_and_safety",
}


def deterministic_issues(task: dict[str, Any], relation: dict[str, Any]) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    contract = task.get("relation_contract") or {}
    expected_inputs = list(relation.get("input_object_ids") or [])
    actual_inputs = [str(item.get("object_id")) for item in task.get("inputs") or [] if isinstance(item, dict)]
    outputs = [item for item in task.get("outputs") or [] if isinstance(item, dict)]
    if contract.get("relation_id") != relation.get("relation_id"):
        issues.append({"code": "relation_id_mismatch", "message": "task relation_id differs from sampled relation"})
    if sorted(map(str, contract.get("input_object_ids") or [])) != sorted(map(str, expected_inputs)):
        issues.append({"code": "relation_contract_input_mismatch", "message": "relation contract must preserve every sampled input object ID"})
    if str(contract.get("output_object_id") or "") != str(relation.get("output_object_id") or ""):
        issues.append({"code": "relation_contract_output_mismatch", "message": "relation contract must preserve the sampled output object ID"})
    if sorted(actual_inputs) != sorted(expected_inputs) or len(actual_inputs) != len(expected_inputs):
        issues.append({"code": "input_object_mismatch", "message": "task inputs must match the sampled k inputs exactly"})
    if len(outputs) != 1 or str(outputs[0].get("object_id") if outputs else "") != str(relation.get("output_object_id")):
        issues.append({"code": "output_object_mismatch", "message": "task must produce exactly the sampled output object"})
    if int(contract.get("k") or 0) != len(expected_inputs):
        issues.append({"code": "k_mismatch", "message": "relation contract k does not match input cardinality"})
    if not str(task.get("name") or "").strip() or not str(task.get("business_goal") or "").strip():
        issues.append({"code": "user_task_incomplete", "message": "task needs a name and business goal"})
    if len(task.get("user_request_examples") or []) < 2:
        issues.append({"code": "user_examples_missing", "message": "task needs at least two natural request examples"})
    for field in task.get("inputs") or []:
        if not isinstance(field, dict) or not (field.get("acquisition") or {}).get("mode"):
            issues.append({"code": "input_acquisition_missing", "message": "every sampled input needs an acquisition path"})
            break
    return issues


def _relation_map(relations: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(item.get("relation_id")): item for item in relations if item.get("relation_id")}


def run(context: StageContext) -> StageExecution:
    candidates = list(context.state.get("p1_task_candidates") or [])
    relations = list(context.state.get("sampled_relations") or [])
    objects = list((context.state.get("object_set") or {}).get("canonical_objects") or [])
    if not candidates or not relations:
        raise ValueError("P1 candidates and sampled relations are required")
    target_count = int((context.state.get("sampling_config") or {}).get("target_count") or len(candidates))
    tool_catalog = (context.state.get("p0_base_result") or {}).get("tool_catalog") or {}
    tool_names = {str(item.get("name")) for item in tool_catalog.get("tools") or [] if isinstance(item, dict) and item.get("name")}
    relation_by_id = _relation_map(relations)
    accepted: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = list(context.state.get("unrealizable_relations") or [])
    files: dict[str, Any] = {}

    for candidate_index, original_candidate in enumerate(candidates, start=1):
        relation_id = str((original_candidate.get("relation_contract") or {}).get("relation_id") or "")
        relation = relation_by_id.get(relation_id)
        if relation is None:
            rejected.append({"task_id": original_candidate.get("task_id"), "reason": "unknown sampled relation"})
            continue
        candidate = deepcopy(original_candidate)
        scenario = scenario_text(relation_context_pack(context.state, relation))
        item_dir = context.run_dir / "stages" / STAGE_NAME / "tasks" / str(candidate.get("task_id") or f"candidate_{candidate_index:03d}")
        hard_issues = deterministic_issues(candidate, relation)
        if hard_issues:
            report = {"passed": False, "repairable": False, "rubrics": {}, "issues": hard_issues, "repair_instructions": []}
        else:
            prompt = p1_validation_prompt(candidate, relation, objects, scenario)
            write_value(item_dir / "validation-prompt.txt", prompt)
            report = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=prompt)
            write_value(item_dir / "validation-model-trace.json", deepcopy(getattr(context.relation_model, "last_trace", {}) or {}))
            files[f"tasks/{candidate['task_id']}/validation-prompt.txt"] = prompt
            files[f"tasks/{candidate['task_id']}/validation-model-trace.json"] = deepcopy(getattr(context.relation_model, "last_trace", {}) or {})
        if not isinstance(report, dict):
            report = {"passed": False, "repairable": False, "rubrics": {}, "issues": [{"code": "invalid_judge_response", "message": "validator did not return an object"}]}

        repaired = False
        if report.get("passed") is not True and report.get("repairable") is True:
            repair_prompt = p1_generation_prompt(relation, objects, scenario, tool_catalog) + "\n\nCORRECTION REQUIRED:\n" + "\n".join(
                f"- {item}" for item in report.get("repair_instructions") or []
            )
            repair_raw = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=repair_prompt)
            write_value(item_dir / "repair-prompt.txt", repair_prompt)
            write_value(item_dir / "repair-output.json", repair_raw)
            files[f"tasks/{candidate['task_id']}/repair-prompt.txt"] = repair_prompt
            files[f"tasks/{candidate['task_id']}/repair-output.json"] = repair_raw
            if isinstance(repair_raw, dict) and repair_raw.get("realizable") is True and isinstance(repair_raw.get("task"), dict):
                candidate = normalize_generated_task(
                    repair_raw["task"], relation, objects,
                    task_index=candidate_index,
                    tool_names=tool_names,
                )
                hard_issues = deterministic_issues(candidate, relation)
                if not hard_issues:
                    retry_prompt = p1_validation_prompt(candidate, relation, objects, scenario)
                    report = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=retry_prompt)
                    files[f"tasks/{candidate['task_id']}/repair-validation-prompt.txt"] = retry_prompt
                    repaired = True
        report_rubrics = report.get("rubrics") or {}
        rubric_values = list(report_rubrics.values())
        semantic_passed = (
            report.get("passed") is True
            and set(report_rubrics) == EXPECTED_RUBRICS
            and all(value == "pass" for value in rubric_values)
            and not (report.get("issues") or [])
        )
        report_record = {
            "task_id": candidate.get("task_id"),
            "relation_id": relation_id,
            "passed": semantic_passed,
            "repaired": repaired,
            "rubrics": report.get("rubrics") or {},
            "issues": report.get("issues") or [],
            "repairable": bool(report.get("repairable")),
        }
        reports.append(report_record)
        write_value(item_dir / "validation-report.json", report_record)
        files[f"tasks/{candidate['task_id']}/validation-report.json"] = report_record
        if report_record["passed"] and len(accepted) < target_count:
            accepted.append(candidate)
            write_value(item_dir / "accepted-task.json", candidate)
            files[f"tasks/{candidate['task_id']}/accepted-task.json"] = candidate
        else:
            rejected.append({
                "task_id": candidate.get("task_id"),
                "relation_id": relation_id,
                "reason": "target_count_reached" if report_record["passed"] else "p1_validation_failed",
                "issues": report_record["issues"],
            })
    if not accepted:
        raise ValueError("no P1 task passed relation and scenario validation")
    return StageExecution(
        input_payload={
            "p1_task_candidates": candidates,
            "sampled_relations": relations,
            "contexts": context.state["inputs"],
            "validation_scope_note": "P0 duplicate comparison is intentionally excluded.",
        },
        output={"p1_tasks": accepted, "validation_reports": reports, "rejected_relations": rejected},
        state_updates={
            "p1_tasks": accepted,
            "p1_validation_reports": reports,
            "rejected_relations": rejected,
            "summary": {**context.state.get("summary", {}), "p1_tasks": len(accepted)},
        },
        trace={
            "operation": "deterministic_and_llm_p1_relation_validation",
            "p0_duplicate_check": False,
            "accepted": len(accepted),
            "rejected": len(rejected),
        },
        files={
            **files,
            "accepted-p1-tasks.json": accepted,
            "validation-reports.json": reports,
            "rejected-relations.json": rejected,
        },
    )
