from __future__ import annotations

import re
from copy import deepcopy
from typing import Any


OBTAINABLE_SOURCES = {
    "profile",
    "state",
    "scenario",
    "user_input",
    "external_data",
    "prior_skill_output",
}
EXTERNAL_TOOL_HINTS = {"WebSearch", "WebFetch", "WebBrowser", "ListMcpResourcesTool", "ReadMcpResourceTool"}
RECURSIVE_TOOL_NAMES = {"Skill", "discover_skills", "ReturnSkillResult", "generatedSkillActionTools", "BaselineAssessment"}


def _terms(value: str) -> set[str]:
    normalized = re.sub(r"\s+", "", value.lower())
    ascii_terms = set(re.findall(r"[a-z0-9_]+", normalized))
    han = "".join(re.findall(r"[\u4e00-\u9fff]", normalized))
    return ascii_terms | {han[index : index + 2] for index in range(max(0, len(han) - 1))}


def candidate_signature(candidate: dict[str, Any]) -> set[str]:
    output_names = " ".join((candidate.get("output_schema") or {}).keys())
    scope = " ".join((candidate.get("scope") or {}).get("includes") or [])
    return _terms(
        " ".join(
            [
                str(candidate.get("skill_name", "")),
                str(candidate.get("business_goal", "")),
                output_names,
                scope,
            ]
        )
    )


def similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
    a = candidate_signature(left)
    b = candidate_signature(right)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _unique(values: list[Any]) -> list[Any]:
    result: list[Any] = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


def consolidate_candidates(
    candidates: list[dict[str, Any]],
    *,
    threshold: float = 0.86,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Deterministically merges only near-identical candidates after LLM review."""
    retained: list[dict[str, Any]] = []
    merge_log: list[dict[str, Any]] = []
    for raw_candidate in candidates:
        candidate = deepcopy(raw_candidate)
        duplicate = next(
            (
                existing
                for existing in retained
                if similarity(existing, candidate) >= threshold
                and bool(
                    set((existing.get("output_schema") or {}).keys())
                    & set((candidate.get("output_schema") or {}).keys())
                )
            ),
            None,
        )
        if duplicate is None:
            retained.append(candidate)
            continue
        duplicate["task_ids"] = _unique(
            list(duplicate.get("task_ids") or []) + list(candidate.get("task_ids") or [])
        )
        duplicate["output_consumers"] = _unique(
            list(duplicate.get("output_consumers") or [])
            + list(candidate.get("output_consumers") or [])
        )
        duplicate["child_tools"] = _unique(
            list(duplicate.get("child_tools") or []) + list(candidate.get("child_tools") or [])
        )
        duplicate["tool_selection"] = _unique(
            list(duplicate.get("tool_selection") or []) + list(candidate.get("tool_selection") or [])
        )
        merge_log.append(
            {
                "action": "deterministic_merge",
                "kept": duplicate.get("skill_id"),
                "merged": candidate.get("skill_id"),
                "similarity": round(similarity(duplicate, candidate), 3),
            }
        )
    return retained, merge_log


def _candidate_report(
    candidate: dict[str, Any],
    *,
    available_tool_names: set[str] | None = None,
    scenario: dict[str, Any] | None = None,
) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    goal = str(candidate.get("business_goal") or "").strip()
    complexity = candidate.get("complexity") or {}
    steps = int(complexity.get("estimated_steps") or 0)
    task_ids = candidate.get("task_ids") or []
    inputs = candidate.get("input_schema") or {}
    outputs = candidate.get("output_schema") or {}
    consumers = candidate.get("output_consumers") or []
    child_tools = set(candidate.get("child_tools") or [])
    tool_selection = candidate.get("tool_selection") or []
    scenario_binding = candidate.get("scenario_binding") or {}

    if len(goal) < 10 or steps < 2 or not outputs:
        issues.append({"code": "goal_too_simple", "severity": "error", "message": "业务目标过于简单或缺少可验证输出"})
    if steps > 7 or len(task_ids) > 3 or complexity.get("level") == "split_required":
        issues.append({"code": "goal_too_complex", "severity": "error", "message": "候选包含过多步骤或多个独立业务决策，应拆分"})

    for name, field in inputs.items():
        source = str((field or {}).get("source") or "")
        required = bool((field or {}).get("required"))
        available = bool((field or {}).get("available"))
        if source not in OBTAINABLE_SOURCES:
            issues.append({"code": "input_unknown_source", "severity": "error", "message": f"输入 {name} 的来源不可识别"})
        if required and not available:
            external_obtainable = source == "external_data" and bool(child_tools & EXTERNAL_TOOL_HINTS)
            if not external_obtainable:
                issues.append({"code": "input_unobtainable", "severity": "error", "message": f"必需输入 {name} 当前不可获得且没有采集能力"})

    if not consumers:
        issues.append({"code": "output_no_consumer", "severity": "error", "message": "输出没有声明消费者"})
    for name, field in outputs.items():
        if not isinstance(field, dict) or not field.get("type") or not field.get("description"):
            issues.append({"code": "output_not_typed", "severity": "error", "message": f"输出 {name} 缺少类型或语义描述"})

    independence = candidate.get("independence") or {}
    if independence.get("portable") is not True:
        issues.append({"code": "main_program_coupling", "severity": "error", "message": "SkillTool 未声明为可移植实现"})
    assumptions = " ".join(map(str, independence.get("assumptions") or [])).lower()
    if re.search(r"cresco|main program|主程序|database table|route|controller", assumptions):
        issues.append({"code": "main_program_coupling", "severity": "error", "message": "运行假设包含主程序实现细节"})

    selected_names: list[str] = []
    for selection in tool_selection:
        if not isinstance(selection, dict):
            issues.append({"code": "tool_selection_invalid", "severity": "error", "message": "工具选择项必须是对象"})
            continue
        name = str(selection.get("tool_name") or "")
        mode = str(selection.get("usage_mode") or "")
        selected_names.append(name)
        if name in RECURSIVE_TOOL_NAMES or "skill" in name.lower():
            issues.append({"code": "recursive_skill_tool", "severity": "error", "message": f"辅助工具 {name} 会造成 Skill 递归嵌套"})
        elif available_tool_names is not None and name not in available_tool_names:
            issues.append({"code": "tool_not_in_catalog", "severity": "error", "message": f"辅助工具 {name} 不在项目工具目录中"})
        if mode not in {"required", "optional", "conditional"}:
            issues.append({"code": "tool_usage_mode_invalid", "severity": "error", "message": f"辅助工具 {name} 缺少合法 usage_mode"})
        if not str(selection.get("reason") or "").strip():
            issues.append({"code": "tool_reason_missing", "severity": "error", "message": f"辅助工具 {name} 未说明选择理由"})
        if mode == "conditional" and not str(selection.get("condition") or "").strip():
            issues.append({"code": "tool_condition_missing", "severity": "error", "message": f"条件式工具 {name} 未说明触发条件"})
        if mode in {"optional", "conditional"} and not str(selection.get("fallback") or "").strip():
            issues.append({"code": "tool_fallback_missing", "severity": "error", "message": f"按需工具 {name} 未说明不用时的降级路径"})
    if child_tools != set(selected_names):
        issues.append({"code": "tool_selection_mismatch", "severity": "error", "message": "child_tools 必须由 tool_selection 精确派生"})

    if scenario is not None:
        target_domain = scenario.get("target_domain") or {}
        expected_mode = str(target_domain.get("mode") or "explicit")
        allowed_domains = set(map(str, target_domain.get("explicit_domains") or []))
        bound_domains = set(map(str, scenario_binding.get("explicit_domains") or []))
        if scenario_binding.get("domain_source") != "scenario_only" or scenario_binding.get("profile_role") != "evidence_only":
            issues.append({"code": "profile_scenario_leakage", "severity": "error", "message": "候选未声明领域仅由场景决定、画像仅作为证据"})
        if scenario_binding.get("domain_mode") != expected_mode:
            issues.append({"code": "scenario_domain_mode_mismatch", "severity": "error", "message": "候选的领域模式与场景不一致"})
        if expected_mode == "open" and bound_domains:
            issues.append({"code": "profile_scenario_leakage", "severity": "error", "message": "开放场景中候选擅自绑定了具体行业"})
        elif expected_mode == "explicit" and not bound_domains.issubset(allowed_domains):
            issues.append({"code": "scenario_domain_out_of_scope", "severity": "error", "message": "候选绑定了场景未明确提供的行业"})

    if not candidate.get("evaluation_cases"):
        issues.append({"code": "missing_evaluation", "severity": "warning", "message": "缺少可执行评测案例"})
    score = max(0, 100 - 18 * sum(item["severity"] == "error" for item in issues) - 6 * sum(item["severity"] == "warning" for item in issues))
    return {
        "skill_id": candidate.get("skill_id"),
        "tool_name": candidate.get("tool_name"),
        "passed": not any(item["severity"] == "error" for item in issues),
        "score": score,
        "issues": issues,
        "checks": {
            "goal_bounded": not any(item["code"] in {"goal_too_simple", "goal_too_complex"} for item in issues),
            "inputs_obtainable": not any(item["code"].startswith("input_") for item in issues),
            "outputs_consumable": not any(item["code"].startswith("output_") for item in issues),
            "main_program_independent": not any(item["code"] == "main_program_coupling" for item in issues),
            "tools_valid_and_justified": not any(item["code"].startswith("tool_") or item["code"] == "recursive_skill_tool" for item in issues),
            "profile_scenario_decoupled": not any(item["code"] in {"profile_scenario_leakage", "scenario_domain_mode_mismatch", "scenario_domain_out_of_scope"} for item in issues),
        },
    }


def evaluate_portfolio(
    candidates: list[dict[str, Any]],
    task_map: dict[str, Any],
    *,
    tool_catalog: dict[str, Any] | None = None,
    scenario: dict[str, Any] | None = None,
) -> dict[str, Any]:
    available_tool_names = (
        {str(tool.get("name")) for tool in tool_catalog.get("tools") or []}
        if tool_catalog is not None
        else None
    )
    reports = [
        _candidate_report(candidate, available_tool_names=available_tool_names, scenario=scenario)
        for candidate in candidates
    ]
    redundancy: list[dict[str, Any]] = []
    for index, left in enumerate(candidates):
        for right in candidates[index + 1 :]:
            score = similarity(left, right)
            if score >= 0.55:
                redundancy.append(
                    {
                        "left": left.get("skill_id"),
                        "right": right.get("skill_id"),
                        "similarity": round(score, 3),
                        "action": "review_merge" if score >= 0.72 else "review_boundary",
                    }
                )

    covered_tasks = {task_id for candidate in candidates for task_id in candidate.get("task_ids") or []}
    all_tasks = {task.get("task_id") for task in task_map.get("tasks") or []}
    missing_tasks = sorted(task for task in all_tasks - covered_tasks if task)
    portfolio_issues = []
    if missing_tasks:
        portfolio_issues.append(
            {"code": "task_coverage_gap", "severity": "error", "tasks": missing_tasks}
        )
    if redundancy:
        portfolio_issues.append(
            {"code": "semantic_overlap", "severity": "warning", "pairs": len(redundancy)}
        )
    passed = all(report["passed"] for report in reports) and not missing_tasks
    average_score = round(sum(report["score"] for report in reports) / max(1, len(reports)), 1)
    return {
        "passed": passed,
        "score": average_score,
        "candidate_reports": reports,
        "redundancy": redundancy,
        "portfolio_issues": portfolio_issues,
        "coverage": {
            "total_tasks": len(all_tasks),
            "covered_tasks": len(all_tasks) - len(missing_tasks),
            "missing_tasks": missing_tasks,
        },
    }
