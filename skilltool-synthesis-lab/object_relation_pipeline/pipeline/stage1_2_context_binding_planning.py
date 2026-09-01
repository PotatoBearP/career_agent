from __future__ import annotations

from copy import deepcopy

from .contexts import context_pack, default_bridge_candidates
from .contracts import StageContext, StageExecution
from .prompts import RELATION_SYSTEM_PROMPT, context_binding_prompt
from .storage import write_value


STAGE_NAME = "stage1_2_context_binding_planning"


def _limit_candidates(candidates: list[dict], limit: int) -> list[dict]:
    remaining = list(candidates)
    selected = []
    covered_profiles: set[str] = set()
    covered_scenarios: set[str] = set()
    while remaining and len(selected) < limit:
        chosen = max(
            remaining,
            key=lambda item: (
                len(set(map(str, item.get("profile_ids") or [])) - covered_profiles)
                + len(set(map(str, item.get("scenario_ids") or [])) - covered_scenarios),
                str(item.get("bridge_group_id")),
            ),
        )
        remaining.remove(chosen)
        selected.append(chosen)
        covered_profiles.update(map(str, chosen.get("profile_ids") or []))
        covered_scenarios.update(map(str, chosen.get("scenario_ids") or []))
    return selected


def run(context: StageContext) -> StageExecution:
    if not (context.state.get("input_validation") or {}).get("passed"):
        raise ValueError("stage1_1_input_validation must pass before context planning")
    inputs = context.state["inputs"]
    policy = (context.options.get("p0") or {})
    all_candidates = default_bridge_candidates(inputs)
    candidates = _limit_candidates(all_candidates, max(1, int(policy.get("max_bridge_candidates", 32))))
    approved = []
    prompt = ""
    model_trace = {}
    raw = {"bridge_groups": []}
    if candidates and float(policy.get("cross_scenario_ratio", 0.0)) > 0:
        prompt = context_binding_prompt(
            {**context_pack(inputs), "policy": {"allow_cross_profile_tasks": False}},
            candidates,
        )
        write_value(context.run_dir / "stages" / STAGE_NAME / "prompt.txt", prompt)
        raw = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=prompt)
        model_trace = deepcopy(getattr(context.relation_model, "last_trace", {}) or {})
        write_value(context.run_dir / "stages" / STAGE_NAME / "model-trace.json", model_trace)
        write_value(context.run_dir / "stages" / STAGE_NAME / "parsed-output.json", raw)
        candidate_by_id = {item["bridge_group_id"]: item for item in candidates}
        for decision in raw.get("bridge_groups") or []:
            candidate = candidate_by_id.get(str(decision.get("bridge_group_id")))
            if candidate and decision.get("approved") is True:
                approved.append({
                    **candidate,
                    "reason": str(decision.get("reason") or "LLM approved semantic bridge"),
                    "integration_theme": str(decision.get("integration_theme") or "cross-scenario synthesis"),
                })
                if len(approved) >= max(1, int(policy.get("max_bridge_groups", 8))):
                    break
    plan = {
        "local_bindings": deepcopy(inputs.get("bindings") or []),
        "bridge_candidates": candidates,
        "bridge_candidate_total": len(all_candidates),
        "bridge_groups": approved,
        "policy": {
            "binding_mode": inputs.get("binding_mode"),
            "allow_cross_profile_tasks": False,
            "cross_scenario_ratio": float(policy.get("cross_scenario_ratio", 0.0)),
        },
    }
    return StageExecution(
        input_payload={"inputs": inputs, "p0_policy": policy},
        output=plan,
        state_updates={"context_plan": plan},
        trace={"operation": "deterministic_binding_plan_plus_llm_bridge_review", "model_trace": model_trace},
        files={"context-plan.json": plan, "bridge-candidates.json": candidates, "bridge-decisions.json": raw},
    )
