from __future__ import annotations

import re
from copy import deepcopy
from typing import Any


OBTAINABLE_SOURCES = {
    "profile",
    "scenario",
    "upstream_artifact",
    "invocation_input",
    "user_input",
    "ordinary_tool_output",
    "external_data",
    "prior_skill_output",
}
EXTERNAL_TOOL_HINTS = {"WebSearch", "WebFetch", "WebBrowser"}
RECURSIVE_TOOL_NAMES = {"Skill", "discover_skills", "ReturnSkillResult", "generatedSkillActionTools", "BaselineAssessment"}


def _canonical(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")


def _required_prior_inputs(candidate: dict[str, Any]) -> set[str]:
    return {
        _canonical((field or {}).get("source_ref") or name)
        for name, field in (candidate.get("input_schema") or {}).items()
        if (field or {}).get("source") == "prior_skill_output" and bool((field or {}).get("required"))
    }


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


CANDIDATE_RUBRICS = (
    ("goal_boundary", "目标边界", {"goal_too_simple", "goal_too_complex"}),
    ("runtime_instructions", "具体可执行的 Skill 说明", {"operating_model_missing", "role_missing", "hard_boundaries_insufficient", "workflow_invalid", "workflow_step_abstract", "decision_rules_missing", "outcome_rules_incomplete", "artifact_contract_incomplete", "final_checks_insufficient"}),
    ("input_availability", "输入契约与可获得性", {"input_description_missing", "input_unknown_source", "input_unobtainable", "input_source_ref_missing", "input_source_ref_unknown", "input_acquisition_missing", "input_acquisition_invalid"}),
    ("output_contract", "输出契约与消费方", {"output_no_consumer", "output_not_typed"}),
    ("implementation_portability", "实现可移植性", {"main_program_coupling"}),
    ("tool_policy", "工具选择与降级策略", {"tool_selection_invalid", "tool_not_in_catalog", "tool_usage_mode_invalid", "tool_reason_missing", "tool_condition_missing", "tool_fallback_missing", "tool_selection_mismatch", "recursive_skill_tool"}),
    ("scenario_alignment", "场景约束与画像隔离", {"profile_scenario_leakage", "scenario_domain_mode_mismatch", "scenario_domain_out_of_scope"}),
    ("independent_invocation", "独立调用能力", {"invocation_mode_invalid", "standalone_requires_prior"}),
    ("evaluation_readiness", "可执行评测案例", {"missing_evaluation"}),
)


def _rubric_status(issues: list[dict[str, Any]]) -> str:
    if any(item.get("severity") == "error" for item in issues):
        return "fail"
    if issues:
        return "warning"
    return "pass"


def _candidate_rubrics(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rubrics = []
    for rubric_id, label, codes in CANDIDATE_RUBRICS:
        matched = [item for item in issues if item.get("code") in codes]
        status = _rubric_status(matched)
        rubrics.append({
            "rubric_id": rubric_id,
            "label": label,
            "status": status,
            "summary": "符合要求" if status == "pass" else "；".join(str(item.get("message") or item.get("code")) for item in matched),
            "issues": matched,
        })
    return rubrics


def _portfolio_rubrics(
    reports: list[dict[str, Any]],
    coverage: dict[str, Any],
    redundancy: list[dict[str, Any]],
    topology: dict[str, Any],
    portfolio_issues: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rubrics: list[dict[str, Any]] = []
    for rubric_id, label, _ in CANDIDATE_RUBRICS:
        affected = []
        matched_issues = []
        for report in reports:
            rubric = next(item for item in report["rubrics"] if item["rubric_id"] == rubric_id)
            if rubric["status"] != "pass":
                affected.append(report.get("skill_id"))
                matched_issues.extend(rubric["issues"])
        status = _rubric_status(matched_issues)
        rubrics.append({
            "rubric_id": rubric_id,
            "label": label,
            "scope": "candidate_portfolio",
            "status": status,
            "summary": "全部候选符合要求" if status == "pass" else f"{len(affected)} 个候选需要处理",
            "affected_skills": affected,
            "evidence": {"checked_skills": len(reports), "issue_count": len(matched_issues)},
            "issues": matched_issues,
        })

    boundary_codes = {"non_skill_task_synthesized", "upstream_inputs_not_reused", "upstream_artifact_reimplemented"}
    boundary_issues = [item for item in portfolio_issues if item.get("code") in boundary_codes]
    rubrics.append({
        "rubric_id": "synthesis_boundary_and_input_reuse",
        "label": "合成边界与输入复用",
        "scope": "portfolio",
        "status": _rubric_status(boundary_issues),
        "summary": "普通 Tool 任务未被重复合成，且已复用前序输入" if not boundary_issues else "合成边界或前序输入复用需要修正",
        "affected_skills": sorted({str(skill_id) for item in boundary_issues for skill_id in item.get("skill_ids", [])}),
        "evidence": {"issue_count": len(boundary_issues)},
        "issues": boundary_issues,
    })

    coverage_issues = [item for item in portfolio_issues if item.get("code") == "task_coverage_gap"]
    rubrics.append({
        "rubric_id": "task_coverage",
        "label": "任务覆盖完整性",
        "scope": "portfolio",
        "status": _rubric_status(coverage_issues),
        "summary": f"覆盖 {coverage['covered_tasks']} / {coverage['total_tasks']} 个任务",
        "affected_skills": [],
        "evidence": coverage,
        "issues": coverage_issues,
    })
    topology_codes = {"standalone_ratio_too_low", "root_ratio_too_low", "dependency_depth_too_high", "dependency_cycle", "unmatched_required_prior_output", "consumer_link_invalid"}
    topology_issues = [item for item in portfolio_issues if item.get("code") in topology_codes]
    rubrics.append({
        "rubric_id": "parallel_composition",
        "label": "并行组合拓扑",
        "scope": "portfolio",
        "status": _rubric_status(topology_issues),
        "summary": f"独立调用 {topology['standalone_count']} / {topology['skill_count']}，根节点 {topology['root_count']} / {topology['skill_count']}，最大必需依赖深度 {topology['max_required_dependency_depth']}",
        "affected_skills": [],
        "evidence": topology,
        "issues": topology_issues,
    })
    overlap_issues = [item for item in portfolio_issues if item.get("code") == "semantic_overlap"]
    rubrics.append({
        "rubric_id": "semantic_distinctness",
        "label": "候选语义区分度",
        "scope": "portfolio",
        "status": _rubric_status(overlap_issues),
        "summary": "无明显重叠" if not redundancy else f"发现 {len(redundancy)} 组边界可能重叠",
        "affected_skills": sorted({str(item[key]) for item in redundancy for key in ("left", "right") if item.get(key)}),
        "evidence": {"overlap_pairs": len(redundancy)},
        "issues": overlap_issues,
    })
    return rubrics


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


def reconcile_candidate_contracts(
    candidates: list[dict[str, Any]],
    *,
    input_inventory: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Normalize task/output aliases while preserving each capability's meaning."""

    reconciled = deepcopy(candidates)
    inventory_ids = {str(item.get("asset_id")) for item in (input_inventory or []) if item.get("asset_id")}
    task_to_skill = {
        str(task_id): str(candidate.get("skill_id"))
        for candidate in reconciled
        for task_id in candidate.get("task_ids") or []
    }
    output_to_producers: dict[str, list[str]] = {}
    for candidate in reconciled:
        for output_name in (candidate.get("output_schema") or {}):
            output_to_producers.setdefault(str(output_name), []).append(str(candidate.get("skill_id")))

    changes: list[dict[str, Any]] = []
    for candidate in reconciled:
        skill_id = str(candidate.get("skill_id"))
        mode = str(candidate.get("invocation_mode") or "standalone")
        child_tools = set(map(str, candidate.get("child_tools") or []))
        for input_name, raw_field in (candidate.get("input_schema") or {}).items():
            field = raw_field or {}
            source = str(field.get("source") or "")
            source_ref = str(field.get("source_ref") or "")
            acquisition = field.get("acquisition") or {}
            provider = str(acquisition.get("provider") or "")
            producers = [item for item in output_to_producers.get(source_ref, []) if item != skill_id]
            if source in {"ordinary_tool_output", "upstream_artifact"} and source_ref not in inventory_ids:
                if source == "ordinary_tool_output" and provider in child_tools:
                    changes.append({"skill_id": skill_id, "input": input_name, "action": "ordinary_tool_provider_reconciled", "provider": provider})
                elif mode == "aggregate" and producers:
                    field["source"] = "prior_skill_output"
                    field["source_ref"] = source_ref
                    field["available"] = True
                    field["acquisition"] = {"mode": "prior_skill", "provider": producers[0], "fallback": None}
                    changes.append({"skill_id": skill_id, "input": input_name, "action": "prior_skill_output_reconciled", "producer": producers[0]})
                else:
                    field["source"] = "invocation_input"
                    field["available"] = True
                    field["acquisition"] = {"mode": "provided", "provider": None, "fallback": None}
                    changes.append({"skill_id": skill_id, "input": input_name, "action": "direct_invocation_input_reconciled", "former_ref": source_ref})
        candidate["composition"] = {
            "required_prior_outputs": [
                name for name, field in (candidate.get("input_schema") or {}).items()
                if (field or {}).get("source") == "prior_skill_output" and bool((field or {}).get("required"))
            ],
            "optional_prior_outputs": [
                name for name, field in (candidate.get("input_schema") or {}).items()
                if (field or {}).get("source") == "prior_skill_output" and not bool((field or {}).get("required"))
            ],
        }
        consumers: list[str] = []
        for consumer in candidate.get("output_consumers") or []:
            normalized = task_to_skill.get(str(consumer), str(consumer))
            if normalized not in consumers:
                consumers.append(normalized)
            if normalized != consumer:
                changes.append({"skill_id": skill_id, "action": "consumer_task_mapped", "from": consumer, "to": normalized})
        candidate["output_consumers"] = consumers
    return reconciled, changes


def _candidate_report(
    candidate: dict[str, Any],
    *,
    available_tool_names: set[str] | None = None,
    scenario: dict[str, Any] | None = None,
    input_inventory: list[dict[str, Any]] | None = None,
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
    required_prior_inputs = _required_prior_inputs(candidate)
    inventory = {str(item.get("asset_id")): item for item in (input_inventory or []) if item.get("asset_id")}
    invocation_mode = str(candidate.get("invocation_mode") or ("aggregate" if required_prior_inputs else "standalone"))

    if invocation_mode not in {"standalone", "aggregate"}:
        issues.append({"code": "invocation_mode_invalid", "severity": "error", "message": "invocation_mode 必须是 standalone 或 aggregate"})
    if invocation_mode == "standalone" and required_prior_inputs:
        issues.append({"code": "standalone_requires_prior", "severity": "error", "message": "独立 SkillTool 不能把其他 SkillTool 输出设为必需输入"})

    if len(goal) < 10 or steps < 2 or not outputs:
        issues.append({"code": "goal_too_simple", "severity": "error", "message": "业务目标过于简单或缺少可验证输出"})
    if steps > 8 or len(task_ids) > 3 or complexity.get("level") == "split_required":
        issues.append({"code": "goal_too_complex", "severity": "error", "message": "候选包含过多步骤或多个独立业务决策，应拆分"})

    operating = candidate.get("operating_model")
    if not isinstance(operating, dict):
        issues.append({"code": "operating_model_missing", "severity": "error", "message": "缺少用于生成具体 SKILL.md 的 operating_model"})
        operating = {}
    if len(str(operating.get("role") or "").strip()) < 10:
        issues.append({"code": "role_missing", "severity": "error", "message": "未定义子模型在该 Skill 中承担的具体角色"})
    boundaries = operating.get("hard_boundaries") or []
    if not isinstance(boundaries, list) or len([item for item in boundaries if str(item).strip()]) < 3:
        issues.append({"code": "hard_boundaries_insufficient", "severity": "error", "message": "至少需要 3 条与候选能力直接相关的硬边界"})
    workflow = operating.get("workflow") or []
    if not isinstance(workflow, list) or not 3 <= len(workflow) <= 6:
        issues.append({"code": "workflow_invalid", "severity": "error", "message": "具体工作流必须包含 3 至 6 个步骤"})
    else:
        vague_only = re.compile(r"^(分析输入|仔细分析|认真分析|生成输出|输出结果|确保质量|analy[sz]e inputs?|reason carefully|generate (the )?output|ensure quality)[。.! ]*$", re.IGNORECASE)
        for index, raw_step in enumerate(workflow, start=1):
            step = raw_step if isinstance(raw_step, dict) else {}
            instructions = [str(item).strip() for item in (step.get("instructions") or []) if str(item).strip()]
            criteria = [str(item).strip() for item in (step.get("success_criteria") or []) if str(item).strip()]
            if not str(step.get("name") or "").strip() or not instructions or not criteria or all(vague_only.match(item) for item in instructions):
                issues.append({"code": "workflow_step_abstract", "severity": "error", "message": f"工作流第 {index} 步缺少具体操作或可观察完成标准"})
    if not isinstance(operating.get("decision_rules"), list) or not operating.get("decision_rules"):
        issues.append({"code": "decision_rules_missing", "severity": "error", "message": "缺少该业务判断所需的确定性规则"})
    outcome_rules = operating.get("outcome_rules") or {}
    if any(not isinstance(outcome_rules.get(name), list) or not outcome_rules.get(name) for name in ("success", "insufficient_input", "error")):
        issues.append({"code": "outcome_rules_incomplete", "severity": "error", "message": "success、insufficient_input 和 error 的条件必须分别定义"})
    artifact_contract = operating.get("artifact_contract") or {}
    if artifact_contract.get("mode") == "write_file" and (
        not artifact_contract.get("artifact_type")
        or not artifact_contract.get("file_name_pattern")
        or artifact_contract.get("format") not in {"json", "markdown"}
        or not artifact_contract.get("verification_steps")
    ):
        issues.append({"code": "artifact_contract_incomplete", "severity": "error", "message": "写文件型 Skill 必须定义产物类型、文件名、格式和写后校验"})
    final_checks = operating.get("final_checks") or []
    if not isinstance(final_checks, list) or len([item for item in final_checks if str(item).strip()]) < 4:
        issues.append({"code": "final_checks_insufficient", "severity": "error", "message": "ReturnSkillResult 前至少需要 4 项候选专属检查"})

    for name, field in inputs.items():
        source = str((field or {}).get("source") or "")
        source_ref = str((field or {}).get("source_ref") or "")
        acquisition = (field or {}).get("acquisition") or {}
        acquisition_mode = str(acquisition.get("mode") or "")
        required = bool((field or {}).get("required"))
        available = bool((field or {}).get("available"))
        if not str((field or {}).get("description") or "").strip():
            issues.append({"code": "input_description_missing", "severity": "error", "message": f"输入 {name} 缺少 description，无法判断其语义和供应是否正确"})
        if source not in OBTAINABLE_SOURCES:
            issues.append({"code": "input_unknown_source", "severity": "error", "message": f"输入 {name} 的来源不可识别"})
        if source == "upstream_artifact":
            if not source_ref:
                issues.append({"code": "input_source_ref_missing", "severity": "error", "message": f"输入 {name} 未声明上游资产 source_ref"})
            elif source_ref not in inventory:
                issues.append({"code": "input_source_ref_unknown", "severity": "error", "message": f"输入 {name} 引用了不存在的输入资产 {source_ref}"})
        if source == "ordinary_tool_output":
            provider = str(acquisition.get("provider") or "")
            if not source_ref and provider not in child_tools:
                issues.append({"code": "input_source_ref_missing", "severity": "error", "message": f"普通工具输入 {name} 未声明资产 source_ref 或已选工具 provider"})
            elif source_ref and source_ref not in inventory and provider not in child_tools:
                issues.append({"code": "input_source_ref_unknown", "severity": "error", "message": f"输入 {name} 引用了不存在的输入资产 {source_ref}"})
        if source == "user_input" and not available and acquisition_mode != "request_user":
            issues.append({"code": "input_acquisition_missing", "severity": "error", "message": f"用户输入 {name} 尚未提供且未声明询问路径"})
        if required and not available:
            external_obtainable = source == "external_data" and bool(child_tools & EXTERNAL_TOOL_HINTS)
            user_obtainable = source == "user_input" and acquisition_mode == "request_user"
            ordinary_tool_obtainable = source == "ordinary_tool_output" and (source_ref in inventory or bool(acquisition.get("provider") in child_tools))
            upstream_available = source == "upstream_artifact" and source_ref in inventory and inventory[source_ref].get("availability") == "available"
            if not any((external_obtainable, user_obtainable, ordinary_tool_obtainable, upstream_available)):
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

    if isinstance(scenario, dict):
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

    evaluation_cases = candidate.get("evaluation_cases") or []
    if not evaluation_cases:
        issues.append({"code": "missing_evaluation", "severity": "warning", "message": "缺少可执行评测案例"})
    else:
        outcomes = {str(item.get("expected_outcome")) for item in evaluation_cases if isinstance(item, dict)}
        boundary_cases = [item for item in evaluation_cases if isinstance(item, dict) and item.get("must_not_include")]
        detailed = all(
            isinstance(item, dict) and item.get("id") and item.get("user_query") and item.get("available_context") is not None
            for item in evaluation_cases
        )
        if not {"success", "insufficient_input"}.issubset(outcomes) or not boundary_cases or not detailed:
            issues.append({"code": "missing_evaluation", "severity": "warning", "message": "评测需包含具体的成功、输入不足和边界案例"})
    rubrics = _candidate_rubrics(issues)
    passed = not any(item["status"] == "fail" for item in rubrics)
    return {
        "skill_id": candidate.get("skill_id"),
        "tool_name": candidate.get("tool_name"),
        "passed": passed,
        "status": "passed" if passed else "needs_revision",
        "issues": issues,
        "rubrics": rubrics,
        "checks": {
            "goal_bounded": not any(item["code"] in {"goal_too_simple", "goal_too_complex"} for item in issues),
            "inputs_obtainable": not any(item["code"].startswith("input_") for item in issues),
            "outputs_consumable": not any(item["code"].startswith("output_") for item in issues),
            "main_program_independent": not any(item["code"] == "main_program_coupling" for item in issues),
            "tools_valid_and_justified": not any(item["code"].startswith("tool_") or item["code"] == "recursive_skill_tool" for item in issues),
            "profile_scenario_decoupled": not any(item["code"] in {"profile_scenario_leakage", "scenario_domain_mode_mismatch", "scenario_domain_out_of_scope"} for item in issues),
            "independently_invocable": not any(item["code"] in {"invocation_mode_invalid", "standalone_requires_prior"} for item in issues),
            "instructions_executable": not any(item["code"] in CANDIDATE_RUBRICS[1][2] for item in issues),
        },
    }


def _portfolio_topology(candidates: list[dict[str, Any]], scenario: dict[str, Any] | None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    ids = {str(candidate.get("skill_id")): candidate for candidate in candidates}
    aliases: dict[str, str] = {}
    output_owners: dict[str, list[str]] = {}
    for skill_id, candidate in ids.items():
        for alias in (skill_id, candidate.get("skill_name"), candidate.get("tool_name")):
            aliases[_canonical(alias)] = skill_id
        for output_name in (candidate.get("output_schema") or {}):
            output_owners.setdefault(_canonical(output_name), []).append(skill_id)

    adjacency = {skill_id: set() for skill_id in ids}
    indegree = {skill_id: 0 for skill_id in ids}
    unmatched_prior: list[dict[str, str]] = []
    for skill_id, candidate in ids.items():
        for input_name in _required_prior_inputs(candidate):
            owners = [owner for owner in output_owners.get(input_name, []) if owner != skill_id]
            if not owners:
                unmatched_prior.append({"skill_id": skill_id, "input": input_name})
            for owner in owners:
                if skill_id not in adjacency[owner]:
                    adjacency[owner].add(skill_id)
                    indegree[skill_id] += 1

    cycle = False
    memo: dict[str, int] = {}
    def depth(skill_id: str, visiting: set[str]) -> int:
        nonlocal cycle
        if skill_id in memo:
            return memo[skill_id]
        if skill_id in visiting:
            cycle = True
            return 0
        value = 1 + max((depth(child, visiting | {skill_id}) for child in adjacency[skill_id]), default=0)
        memo[skill_id] = value
        return value

    max_depth = max((depth(skill_id, set()) for skill_id in ids), default=0)
    root_count = sum(value == 0 for value in indegree.values())
    standalone_count = sum(
        str(candidate.get("invocation_mode") or ("aggregate" if _required_prior_inputs(candidate) else "standalone")) == "standalone"
        and not _required_prior_inputs(candidate)
        for candidate in candidates
    )
    count = max(1, len(candidates))
    preferences = (scenario.get("composition_preferences") or {}) if isinstance(scenario, dict) else {}
    min_standalone_ratio = float(preferences.get("min_standalone_ratio", 0.5))
    min_root_ratio = float(preferences.get("min_root_ratio", 0.5))
    max_allowed_depth = int(preferences.get("max_required_dependency_depth", 3))
    issues: list[dict[str, Any]] = []
    standalone_ratio = standalone_count / count
    root_ratio = root_count / count
    if standalone_ratio < min_standalone_ratio:
        issues.append({"code": "standalone_ratio_too_low", "severity": "error", "actual": round(standalone_ratio, 3), "required": min_standalone_ratio})
    if root_ratio < min_root_ratio:
        issues.append({"code": "root_ratio_too_low", "severity": "error", "actual": round(root_ratio, 3), "required": min_root_ratio})
    if max_depth > max_allowed_depth:
        issues.append({"code": "dependency_depth_too_high", "severity": "error", "actual": max_depth, "maximum": max_allowed_depth})
    if cycle:
        issues.append({"code": "dependency_cycle", "severity": "error"})
    if unmatched_prior:
        issues.append({"code": "unmatched_required_prior_output", "severity": "error", "items": unmatched_prior})

    invalid_consumers: list[dict[str, str]] = []
    for skill_id, candidate in ids.items():
        output_names = {_canonical(name) for name in (candidate.get("output_schema") or {})}
        for raw_consumer in candidate.get("output_consumers") or []:
            consumer = _canonical(raw_consumer)
            target_id = aliases.get(consumer)
            if target_id:
                target_input_schema = ids[target_id].get("input_schema") or {}
                target_inputs = {_canonical(name) for name in target_input_schema}
                target_inputs.update(
                    _canonical(field.get("source_ref"))
                    for field in target_input_schema.values()
                    if isinstance(field, dict) and field.get("source_ref")
                )
                if not output_names & target_inputs:
                    invalid_consumers.append({"producer": skill_id, "consumer": target_id})
            elif not any(token in consumer for token in ("user", "decision", "external", "system")):
                invalid_consumers.append({"producer": skill_id, "consumer": str(raw_consumer)})
    if invalid_consumers:
        issues.append({"code": "consumer_link_invalid", "severity": "error", "items": invalid_consumers})

    return {
        "skill_count": len(candidates),
        "standalone_count": standalone_count,
        "standalone_ratio": round(standalone_ratio, 3),
        "root_count": root_count,
        "root_ratio": round(root_ratio, 3),
        "required_dependency_edges": sum(len(children) for children in adjacency.values()),
        "max_required_dependency_depth": max_depth,
        "has_cycle": cycle,
    }, issues


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
        _candidate_report(candidate, available_tool_names=available_tool_names, scenario=scenario, input_inventory=task_map.get("input_inventory") or [])
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
    tasks_by_id = {task.get("task_id"): task for task in task_map.get("tasks") or [] if task.get("task_id")}
    all_tasks = {
        task.get("task_id")
        for task in task_map.get("tasks") or []
        if str(task.get("synthesis_decision") or "skilltool") == "skilltool"
    }
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
    non_skill_candidates = [
        str(candidate.get("skill_id"))
        for candidate in candidates
        if any(
            task_id in tasks_by_id
            and str(tasks_by_id[task_id].get("synthesis_decision") or "skilltool") != "skilltool"
            for task_id in candidate.get("task_ids") or []
        )
    ]
    if non_skill_candidates:
        portfolio_issues.append({"code": "non_skill_task_synthesized", "severity": "error", "skill_ids": non_skill_candidates})
    inventory = task_map.get("input_inventory") or []
    upstream_assets = {
        _canonical(item.get("asset_id"))
        for item in inventory
        if item.get("source") in {"upstream_artifact", "ordinary_tool_output"}
        and item.get("availability") == "available"
    }
    referenced_assets = {
        _canonical(field.get("source_ref"))
        for candidate in candidates
        for field in (candidate.get("input_schema") or {}).values()
        if isinstance(field, dict) and field.get("source_ref")
    }
    if upstream_assets and not upstream_assets & referenced_assets:
        portfolio_issues.append({"code": "upstream_inputs_not_reused", "severity": "error", "available_assets": sorted(upstream_assets)})
    reimplemented = [
        str(candidate.get("skill_id"))
        for candidate in candidates
        if upstream_assets & {_canonical(name) for name in (candidate.get("output_schema") or {})}
    ]
    if reimplemented:
        portfolio_issues.append({"code": "upstream_artifact_reimplemented", "severity": "error", "skill_ids": reimplemented})
    topology, topology_issues = _portfolio_topology(candidates, scenario)
    portfolio_issues.extend(topology_issues)
    coverage = {
        "total_tasks": len(all_tasks),
        "covered_tasks": len(all_tasks) - len(missing_tasks),
        "missing_tasks": missing_tasks,
    }
    rubrics = _portfolio_rubrics(reports, coverage, redundancy, topology, portfolio_issues)
    passed = not any(item["status"] == "fail" for item in rubrics)
    return {
        "passed": passed,
        "status": "passed" if passed else "needs_revision",
        "rubrics": rubrics,
        "rubric_summary": {
            "passed": sum(item["status"] == "pass" for item in rubrics),
            "warnings": sum(item["status"] == "warning" for item in rubrics),
            "failed": sum(item["status"] == "fail" for item in rubrics),
            "total": len(rubrics),
        },
        "candidate_reports": reports,
        "redundancy": redundancy,
        "portfolio_issues": portfolio_issues,
        "topology": topology,
        "coverage": coverage,
    }
