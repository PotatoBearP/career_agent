from __future__ import annotations

from copy import deepcopy
from statistics import mean

from .contexts import task_context_pack
from .contracts import StageContext, StageExecution
from .prompts import RELATION_SYSTEM_PROMPT, p0_complexity_prompt
from .storage import write_value


STAGE_NAME = "stage1_5_p0_complexity_validation"
SCORE_KEYS = {"information_diversity", "transformation_depth", "output_novelty", "business_value", "boundedness"}


def run(context: StageContext) -> StageExecution:
    candidates = context.state.get("p0_task_candidates") or []
    if not candidates:
        raise ValueError("P0 candidates are required")
    policy = context.options.get("p0") or {}
    reports = []
    passed = []
    files = {}
    for task in candidates:
        task_id = str(task["task_id"])
        prompt = p0_complexity_prompt(task, task_context_pack(context.state, task))
        item_dir = context.run_dir / "stages" / STAGE_NAME / "tasks" / task_id
        write_value(item_dir / "prompt.txt", prompt)
        raw = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=prompt)
        model_trace = deepcopy(getattr(context.relation_model, "last_trace", {}) or {})
        write_value(item_dir / "model-trace.json", model_trace)
        write_value(item_dir / "parsed-output.json", raw)
        minimal_inputs = raw.get("minimal_inputs") if isinstance(raw.get("minimal_inputs"), list) else []
        minimal_outputs = raw.get("minimal_outputs") if isinstance(raw.get("minimal_outputs"), list) else []
        m = len(minimal_inputs)
        n = len(minimal_outputs)
        raw_scores = raw.get("complexity_scores") or {}
        score_contract_valid = set(raw_scores) == SCORE_KEYS and all(
            isinstance(raw_scores.get(key), (int, float)) and 0.0 <= float(raw_scores[key]) <= 1.0
            for key in SCORE_KEYS
        )
        scores = [float(raw_scores[key]) for key in SCORE_KEYS] if score_contract_valid else []
        score = round(mean(scores), 4) if scores else 0.0
        cross_required = (task.get("context_contract") or {}).get("mode") == "cross_scenario"
        expected_scenarios = set(map(str, (task.get("context_contract") or {}).get("scenario_ids") or []))
        contribution_scenarios = {
            str(item.get("scenario_id"))
            for item in (task.get("context_contract") or {}).get("scenario_contributions") or []
            if isinstance(item, dict) and item.get("scenario_id")
        }
        input_scenarios = {
            str(value)
            for field in task.get("inputs") or []
            if isinstance(field, dict)
            for value in field.get("scenario_ids") or []
        }
        cross_contract_valid = not cross_required or (
            bool(expected_scenarios)
            and expected_scenarios <= contribution_scenarios
            and expected_scenarios <= input_scenarios
        )
        accepted = bool(raw.get("passed"))
        accepted = accepted and score_contract_valid and int(raw.get("m") or 0) == m and int(raw.get("n") or 0) == n
        accepted = accepted and m >= int(policy.get("hard_min_m", 1)) and n >= int(policy.get("hard_min_n", 1))
        accepted = accepted and score >= float(policy.get("min_complexity_score", 0.65))
        accepted = accepted and (not cross_required or (raw.get("cross_scenario_fidelity") is True and cross_contract_valid))
        report = {
            "task_id": task_id,
            "passed": accepted,
            "m": m,
            "n": n,
            "complexity_score": score,
            "preferred_m_met": m >= int(policy.get("preferred_min_m", 2)),
            "score_contract_valid": score_contract_valid,
            "cross_context_contract_valid": cross_contract_valid,
            "model_audit": raw,
        }
        reports.append(report)
        if accepted:
            passed.append({**deepcopy(task), "p0_complexity": {key: value for key, value in report.items() if key != "model_audit"}})
        write_value(item_dir / "complexity-report.json", report)
        files[f"tasks/{task_id}/prompt.txt"] = prompt
        files[f"tasks/{task_id}/model-trace.json"] = model_trace
        files[f"tasks/{task_id}/parsed-output.json"] = raw
        files[f"tasks/{task_id}/complexity-report.json"] = report
    if not passed:
        raise ValueError("all P0 candidates failed the hidden m-to-n complexity gate")
    summary = {**context.state.get("summary", {}), "p0_complexity_passed": len(passed)}
    return StageExecution(
        input_payload={"p0_task_candidates": candidates, "complexity_policy": policy},
        output={"reports": reports, "passed_candidates": passed},
        state_updates={"p0_complexity_reports": reports, "p0_complexity_passed": passed, "summary": summary},
        trace={"operation": "llm_semantic_m_to_n_complexity_audit_plus_deterministic_gate", "task_count": len(candidates)},
        files={**files, "complexity-reports.json": reports, "passed-candidates.json": passed},
    )
