from __future__ import annotations

import sys
from copy import deepcopy
from pathlib import Path
from typing import Any

from .contracts import StageContext, StageExecution
from .prompts import RELATION_SYSTEM_PROMPT, p0_portfolio_dedupe_prompt
from .storage import write_value


LAB_ROOT = Path(__file__).resolve().parents[2]
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from pipeline.synthesis import build_task_io_pools  # noqa: E402


STAGE_NAME = "stage1_6_p0_portfolio_finalization"


def _union_contract(tasks: list[dict[str, Any]]) -> dict[str, Any]:
    contracts = [item.get("context_contract") or {} for item in tasks]
    values = lambda key: list(dict.fromkeys(str(value) for contract in contracts for value in contract.get(key) or []))
    modes = {str(item.get("mode") or "local") for item in contracts}
    return {
        "mode": "cross_scenario" if "cross_scenario" in modes else "local",
        "profile_ids": values("profile_ids"),
        "scenario_ids": values("scenario_ids"),
        "binding_ids": values("binding_ids"),
        "scenario_contributions": [entry for contract in contracts for entry in contract.get("scenario_contributions") or []],
        "integration_reason": "; ".join(dict.fromkeys(str(item.get("integration_reason") or "") for item in contracts if item.get("integration_reason"))),
    }


def _semantic_representatives(candidates: list[dict[str, Any]], raw: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_id = {str(item["task_id"]): item for item in candidates}
    consumed = set()
    representatives = []
    decisions = []
    for group in raw.get("groups") or []:
        member_ids = list(dict.fromkeys(str(item) for item in group.get("member_task_ids") or [] if str(item) in by_id))
        representative_id = str(group.get("representative_task_id") or "")
        if representative_id not in member_ids and representative_id in by_id:
            member_ids.insert(0, representative_id)
        member_ids = [item for item in member_ids if item not in consumed]
        if not member_ids:
            continue
        representative_id = representative_id if representative_id in member_ids else member_ids[0]
        members = [by_id[item] for item in member_ids]
        representative = deepcopy(by_id[representative_id])
        representative["context_contract"] = _union_contract(members)
        representative["semantic_duplicate_task_ids"] = member_ids
        representatives.append(representative)
        consumed.update(member_ids)
        decisions.append({"representative_task_id": representative_id, "member_task_ids": member_ids, "reason": str(group.get("reason") or "LLM semantic group")})
    for task in candidates:
        if str(task["task_id"]) not in consumed:
            representative = deepcopy(task)
            representative["semantic_duplicate_task_ids"] = [str(task["task_id"])]
            representatives.append(representative)
            decisions.append({"representative_task_id": task["task_id"], "member_task_ids": [task["task_id"]], "reason": "not grouped by the LLM"})
    return representatives, decisions


def _select(candidates: list[dict[str, Any]], target: int, bridge_target: int) -> list[dict[str, Any]]:
    remaining = list(candidates)
    selected: list[dict[str, Any]] = []
    covered_profiles: set[str] = set()
    covered_scenarios: set[str] = set()
    covered_bindings: set[str] = set()
    def take_best(pool: list[dict[str, Any]]) -> dict[str, Any]:
        def score(task: dict[str, Any]) -> tuple[Any, ...]:
            contract = task.get("context_contract") or {}
            new_coverage = (
                len(set(map(str, contract.get("profile_ids") or [])) - covered_profiles)
                + len(set(map(str, contract.get("scenario_ids") or [])) - covered_scenarios)
                + len(set(map(str, contract.get("binding_ids") or [])) - covered_bindings)
            )
            complexity = float((task.get("p0_complexity") or {}).get("complexity_score") or 0.0)
            bridge = 1 if contract.get("mode") == "cross_scenario" else 0
            return new_coverage, bridge, complexity, str(task.get("task_id"))
        return max(pool, key=score)

    while remaining and len(selected) < min(target, bridge_target):
        bridge_pool = [item for item in remaining if (item.get("context_contract") or {}).get("mode") == "cross_scenario"]
        if not bridge_pool:
            break
        chosen = take_best(bridge_pool)
        remaining.remove(chosen)
        selected.append(chosen)
        contract = chosen.get("context_contract") or {}
        covered_profiles.update(map(str, contract.get("profile_ids") or []))
        covered_scenarios.update(map(str, contract.get("scenario_ids") or []))
        covered_bindings.update(map(str, contract.get("binding_ids") or []))
    while remaining and len(selected) < target:
        local_pool = [item for item in remaining if (item.get("context_contract") or {}).get("mode") != "cross_scenario"]
        chosen = take_best(local_pool or remaining)
        remaining.remove(chosen)
        selected.append(chosen)
        contract = chosen.get("context_contract") or {}
        covered_profiles.update(map(str, contract.get("profile_ids") or []))
        covered_scenarios.update(map(str, contract.get("scenario_ids") or []))
        covered_bindings.update(map(str, contract.get("binding_ids") or []))
    return selected


def run(context: StageContext) -> StageExecution:
    candidates = context.state.get("p0_complexity_passed") or []
    if not candidates:
        raise ValueError("complexity-passed P0 candidates are required")
    prompt = p0_portfolio_dedupe_prompt(candidates)
    write_value(context.run_dir / "stages" / STAGE_NAME / "prompt.txt", prompt)
    raw = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=prompt)
    model_trace = deepcopy(getattr(context.relation_model, "last_trace", {}) or {})
    write_value(context.run_dir / "stages" / STAGE_NAME / "model-trace.json", model_trace)
    write_value(context.run_dir / "stages" / STAGE_NAME / "parsed-output.json", raw)
    representatives, decisions = _semantic_representatives(candidates, raw if isinstance(raw, dict) else {})
    target = max(1, int((context.options.get("p0") or {}).get("target_count", len(representatives))))
    cross_ratio = min(1.0, max(0.0, float((context.options.get("p0") or {}).get("cross_scenario_ratio", 0.0))))
    bridge_target = round(target * cross_ratio)
    selected = _select(representatives, min(target, len(representatives)), bridge_target)
    expected_profiles = {str(item["profile_id"]) for item in context.state["inputs"].get("profiles") or []}
    expected_scenarios = {str(item["scenario_id"]) for item in context.state["inputs"].get("scenarios") or []}
    expected_bindings = {str(item["binding_id"]) for item in context.state["inputs"].get("bindings") or []}
    covered_profiles = {value for task in selected for value in (task.get("context_contract") or {}).get("profile_ids") or []}
    covered_scenarios = {value for task in selected for value in (task.get("context_contract") or {}).get("scenario_ids") or []}
    covered_bindings = {value for task in selected for value in (task.get("context_contract") or {}).get("binding_ids") or []}
    coverage = {
        "profiles": {"covered": sorted(covered_profiles), "missing": sorted(expected_profiles - covered_profiles)},
        "scenarios": {"covered": sorted(covered_scenarios), "missing": sorted(expected_scenarios - covered_scenarios)},
        "bindings": {"covered": sorted(covered_bindings), "missing": sorted(expected_bindings - covered_bindings)},
        "cross_scenario_tasks": sum(1 for item in selected if (item.get("context_contract") or {}).get("mode") == "cross_scenario"),
        "cross_scenario_target": bridge_target,
        "cross_scenario_shortfall": max(0, bridge_target - sum(1 for item in selected if (item.get("context_contract") or {}).get("mode") == "cross_scenario")),
    }
    base_results = context.state.get("p0_base_results") or []
    base_result = deepcopy((base_results[0] if base_results else {}).get("result") or {})
    input_pool, output_pool = build_task_io_pools(selected)
    task_map = deepcopy(base_result.get("task_map") or {})
    task_map.update({
        "tasks": selected,
        "input_pool": input_pool,
        "output_pool": output_pool,
        "coverage": coverage,
        "input_inventory": (context.state.get("input_validation") or {}).get("input_inventory") or [],
    })
    base_result["inputs"] = deepcopy(context.state["inputs"])
    base_result["input_validation"] = deepcopy(context.state.get("input_validation") or {})
    base_result["task_map"] = task_map
    base_result.setdefault("summary", {})["tasks"] = len(selected)
    summary = {**context.state.get("summary", {}), "p0_tasks": len(selected)}
    output = {"p0_tasks": selected, "coverage": coverage, "semantic_dedupe": decisions}
    return StageExecution(
        input_payload={"passed_candidates": candidates, "target_count": target},
        output=output,
        state_updates={"p0_tasks": selected, "p0_base_result": base_result, "p0_coverage": coverage, "summary": summary},
        trace={"operation": "llm_semantic_dedupe_plus_deterministic_coverage_selection", "model_trace": model_trace},
        files={
            "semantic-dedupe.json": decisions,
            "deduped-candidates.json": representatives,
            "selection.json": {"target_count": target, "bridge_target": bridge_target, "selected_task_ids": [item["task_id"] for item in selected]},
            "coverage.json": coverage,
            "p0-tasks.json": selected,
            "p0-task-map.json": task_map,
            "base-pipeline-result.json": base_result,
        },
    )
