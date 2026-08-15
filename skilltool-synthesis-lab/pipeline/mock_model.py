from __future__ import annotations

from copy import deepcopy
from typing import Any


def _field(
    field_type: str,
    description: str,
    source: str,
    *,
    required: bool = True,
    available: bool = True,
) -> dict[str, Any]:
    return {
        "type": field_type,
        "required": required,
        "description": description,
        "source": source,
        "available": available,
    }


def _out(field_type: str, description: str) -> dict[str, str]:
    return {"type": field_type, "description": description}


def _tool(
    name: str,
    mode: str,
    reason: str,
    *,
    condition: str | None = None,
    fallback: str | None = None,
) -> dict[str, Any]:
    return {
        "tool_name": name,
        "usage_mode": mode,
        "reason": reason,
        "condition": condition,
        "fallback": fallback,
    }


def _candidate(
    skill_id: str,
    tool_name: str,
    title: str,
    goal: str,
    task_ids: list[str],
    inputs: dict[str, dict[str, Any]],
    outputs: dict[str, dict[str, str]],
    consumers: list[str],
    *,
    tool_selection: list[dict[str, Any]] | None = None,
    fresh_data_policy: str = "none",
    includes: list[str] | None = None,
    excludes: list[str] | None = None,
    steps: int = 4,
) -> dict[str, Any]:
    return {
        "skill_id": skill_id,
        "skill_name": skill_id.replace("_", "-"),
        "tool_name": tool_name,
        "title": title,
        "business_goal": goal,
        "when_to_use": f"当需要{goal}时使用。",
        "task_ids": task_ids,
        "scenario_binding": {
            "domain_source": "scenario_only",
            "domain_mode": "open",
            "explicit_domains": [],
            "profile_role": "evidence_only",
        },
        "scope": {
            "includes": includes or [goal],
            "excludes": excludes or ["替用户做最终决定", "修改主程序状态"],
        },
        "input_schema": inputs,
        "output_schema": outputs,
        "output_consumers": consumers,
        "tool_selection": tool_selection or [],
        "child_tools": [item["tool_name"] for item in (tool_selection or [])],
        "fresh_data_policy": fresh_data_policy,
        "complexity": {
            "level": "bounded",
            "estimated_steps": steps,
            "rationale": "形成一个可独立验证、可被后续任务消费的业务结果。",
        },
        "independence": {
            "portable": True,
            "assumptions": ["输入通过JSON契约提供", "模型通过外部API运行"],
        },
        "evaluation_cases": [
            {"case": "输入完整且证据充分", "expected_outcome": "success"},
            {"case": "缺少关键必需输入", "expected_outcome": "insufficient_input"},
        ],
    }


NEEDS = {
    "scenario_interpretation": {
        "scenario_goal": "在目标领域开放时形成跨行业、岗位族和组织的机会探索空间",
        "domain_mode": "open",
        "explicit_domains": [],
        "profile_facts_used_as_evidence": ["教育经历", "能力证据", "价值偏好", "生活约束"],
        "forbidden_profile_to_scenario_inferences": ["由计算机专业推断目标行业为AI", "由RAG项目推断目标岗位为大模型工程师"],
    },
    "decision_context": {
        "stage": "graduate_exploration",
        "primary_decision": "形成2-3个跨领域、值得进一步验证的工作与机会组合",
        "constraints": ["缺少正式实习", "目标领域开放", "市场信息需要刷新"],
        "known_evidence": ["计算机硕士教育背景", "技术项目", "价值偏好", "地点与组织偏好"],
        "missing_evidence": ["跨行业岗位样本", "不同工作形态体验", "能力证据的跨领域迁移性"],
        "success_definition": ["机会空间覆盖完整", "结论可追溯到证据", "形成可比较的优先级", "给出低成本验证任务"],
    },
    "needs": [
        {"need_id": "career_stage_clarity", "business_need": "识别当前职业决策阶段和约束", "why_now": "决定探索任务的粒度", "decision_enabled": "选择发散、收敛或验证策略", "evidence_required": ["教育阶段", "经历", "决策期限"], "priority": "must"},
        {"need_id": "direction_hypotheses", "business_need": "形成多条跨行业、跨职能且可验证的职业假设", "why_now": "避免把专业当成唯一方向", "decision_enabled": "选择后续探索范围", "evidence_required": ["能力", "动机", "偏好", "约束"], "priority": "must"},
        {"need_id": "market_landscape", "business_need": "比较产业问题、价值链和组织生态", "why_now": "目标领域尚未显式确定", "decision_enabled": "选择需要深入的产业问题", "evidence_required": ["当前产业资料", "组织与产品信号"], "priority": "must"},
        {"need_id": "role_landscape", "business_need": "比较不同工作形态、岗位族及真实要求", "why_now": "职能偏好尚未通过体验验证", "decision_enabled": "形成岗位族组合", "evidence_required": ["岗位定义", "工作内容", "JD样本"], "priority": "must"},
        {"need_id": "opportunity_inventory", "business_need": "发现具体雇主和岗位机会", "why_now": "需要把方向转成可行动对象", "decision_enabled": "建立机会池", "evidence_required": ["招聘页面", "岗位链接", "地点"], "priority": "should"},
        {"need_id": "fit_evidence", "business_need": "把个人证据映射到岗位要求", "why_now": "识别可主张优势和未知项", "decision_enabled": "判断哪些机会值得验证", "evidence_required": ["项目证据", "岗位要求"], "priority": "must"},
        {"need_id": "portfolio_priority", "business_need": "按匹配、成长性、可进入性和偏好排序", "why_now": "把发散结果收敛为2-3条路径", "decision_enabled": "确定验证优先级", "evidence_required": ["方向、岗位、机会、证据"], "priority": "must"},
        {"need_id": "validation_plan", "business_need": "设计低成本验证任务", "why_now": "当前证据不足以做最终选择", "decision_enabled": "用新证据更新方向判断", "evidence_required": ["主要不确定性", "可用时间"], "priority": "should"}
    ]
}


TASKS = [
    ("career_stage_diagnosis", "职业阶段识别", "判断当前处于发散、收敛还是验证阶段", [], False),
    ("direction_hypothesis_formation", "跨领域假设形成", "形成不受专业预设限制的职业方向集合", ["career_stage_diagnosis"], False),
    ("industry_problem_landscape", "产业问题与价值链探索", "形成跨行业问题、价值链位置和组织生态地图", ["direction_hypothesis_formation"], True),
    ("role_family_mapping", "岗位族与工作形态探索", "比较研究、工程、产品、运营、咨询等工作形态", ["direction_hypothesis_formation"], True),
    ("employer_segment_mapping", "组织生态探索", "识别适配的组织类型、团队环境和代表组织", ["industry_problem_landscape"], True),
    ("opportunity_signal_discovery", "具体机会发现", "形成带来源和时效的岗位机会池", ["role_family_mapping", "employer_segment_mapping"], True),
    ("capability_evidence_mapping", "能力证据映射", "将个人证据映射到岗位要求并标记未知项", ["role_family_mapping"], False),
    ("opportunity_fit_scoring", "机会组合排序", "对方向和机会进行多维比较并形成优先级", ["opportunity_signal_discovery", "capability_evidence_mapping"], False),
    ("exploration_experiment_design", "探索实验设计", "为高优先级方向设计低成本验证任务", ["opportunity_fit_scoring"], False),
]


def _task_map() -> dict[str, Any]:
    tasks = []
    for task_id, name, goal, dependencies, fresh in TASKS:
        tasks.append({
            "task_id": task_id,
            "name": name,
            "scene": "行业探索与机会发现（目标领域开放）",
            "business_goal": goal,
            "need_ids": [],
            "inputs": [{"name": "upstream_context", "source": "prior_output" if dependencies else "profile", "available": True, "from_task": dependencies[0] if dependencies else None}],
            "outputs": [{"name": f"{task_id}_result", "consumer_tasks": [item[0] for item in TASKS if task_id in item[3]], "final_consumer": "decision" if task_id in {"opportunity_fit_scoring", "exploration_experiment_design"} else None}],
            "dependencies": dependencies,
            "estimated_steps": 4,
            "fresh_data_required": fresh,
        })
    return {
        "tasks": tasks,
        "coverage": [
            {"required_output": "职业阶段与决策约束摘要", "covered_by": ["career_stage_diagnosis"]},
            {"required_output": "候选方向集合", "covered_by": ["direction_hypothesis_formation"]},
            {"required_output": "产业问题与价值链机会地图", "covered_by": ["industry_problem_landscape"]},
            {"required_output": "岗位族、工作形态与要求矩阵", "covered_by": ["role_family_mapping"]},
            {"required_output": "目标雇主与机会清单", "covered_by": ["employer_segment_mapping", "opportunity_signal_discovery"]},
            {"required_output": "优先级结果", "covered_by": ["opportunity_fit_scoring"]},
            {"required_output": "下一轮验证任务", "covered_by": ["exploration_experiment_design"]},
        ],
    }


def _candidates() -> list[dict[str, Any]]:
    profile = _field("object", "用户教育、能力、经历、偏好和约束画像", "profile")
    state = _field("object", "当前职业阶段、假设和决策状态", "state")
    external = _field("array", "带来源和时间戳的外部市场证据", "external_data", available=False)
    prior = lambda description: _field("object", description, "prior_skill_output")
    market_tools = [
        _tool("WebSearch", "required", "场景要求比较当前产业与机会信号，需要带来源的最新公开证据"),
        _tool("WebFetch", "conditional", "在搜索结果摘要不足以支持判断时读取原始页面", condition="候选来源与关键结论需要原文核验", fallback="保留摘要来源并降低对应结论置信度"),
    ]
    discovery_tools = [
        _tool("WebSearch", "required", "发现当前公开岗位、项目或组织机会"),
        _tool("WebFetch", "conditional", "核验具体机会页面的要求与时效", condition="搜索结果提供可访问的具体机会链接", fallback="将机会标记为未核验，不把它纳入高置信度结果"),
    ]
    return [
        _candidate("career_stage_assessment", "CareerStageAssessment", "职业阶段识别", "识别用户当前职业决策阶段、约束和需要解决的决策", ["career_stage_diagnosis"], {"profile": profile, "state": state}, {"stage_assessment": _out("object", "阶段、约束、证据和不确定性")}, ["career-direction-hypothesis"], excludes=["生成岗位清单", "推荐具体公司"]),
        _candidate("career_direction_hypothesis", "CareerDirectionHypothesis", "跨领域职业假设", "基于个人证据形成互相区分且不受专业预设限制的职业方向假设", ["direction_hypothesis_formation"], {"profile": profile, "scenario": _field("object", "独立定义的问题空间和领域边界", "scenario"), "stage_assessment": prior("职业阶段识别结果")}, {"direction_hypotheses": _out("array", "跨领域方向、依据、反证条件和待验证问题")}, ["industry-problem-landscape", "role-family-positioning"], excludes=["从专业直接推断目标行业", "只生成技术岗位"]),
        _candidate("industry_problem_landscape", "IndustryProblemLandscape", "产业问题与价值链地图", "把当前外部证据组织为跨行业问题、价值链位置和组织生态的可比较地图", ["industry_problem_landscape"], {"direction_hypotheses": prior("跨领域职业方向"), "market_evidence": external}, {"industry_landscape": _out("object", "产业问题、价值链位置、信号、风险和来源")}, ["employer-target-mapping", "opportunity-portfolio-prioritization"], tool_selection=market_tools, fresh_data_policy="required", excludes=["替用户选定行业", "无来源预测行业增长", "由专业限定产业范围"]),
        _candidate("role_family_positioning", "RoleFamilyPositioning", "岗位族与工作形态定位", "比较候选岗位族的工作内容、责任、能力要求和进入路径并形成岗位组合", ["role_family_mapping"], {"profile": profile, "direction_hypotheses": prior("跨领域候选方向"), "job_evidence": external}, {"role_family_matrix": _out("array", "岗位族、工作形态、职责、要求、相邻岗位和证据来源")}, ["capability-evidence-assessment", "live-opportunity-discovery"], tool_selection=market_tools, fresh_data_policy="required"),
        _candidate("employer_target_mapping", "EmployerTargetMapping", "组织生态地图", "按产业问题、组织类型、地点和团队环境形成可解释的目标组织分层", ["employer_segment_mapping"], {"profile": profile, "industry_landscape": prior("产业问题与价值链地图"), "organization_evidence": external}, {"employer_segments": _out("array", "组织分层、代表组织、环境特征、适配理由和验证项")}, ["live-opportunity-discovery"], tool_selection=market_tools, fresh_data_policy="required"),
        _candidate("live_opportunity_discovery", "LiveOpportunityDiscovery", "实时机会发现", "基于目标问题、岗位族和组织范围发现带链接、时间与证据的岗位、项目或实习机会", ["opportunity_signal_discovery"], {"role_family_matrix": prior("岗位族矩阵"), "employer_segments": prior("目标组织分层"), "search_constraints": _field("object", "地点、时间、机会类型和组织偏好", "profile")}, {"opportunity_inventory": _out("array", "机会类型、角色、组织、链接、发布时间、要求摘要和来源")}, ["capability-evidence-assessment", "opportunity-portfolio-prioritization"], tool_selection=discovery_tools, fresh_data_policy="required", excludes=["自动投递", "虚构机会状态"]),
        _candidate("capability_evidence_assessment", "CapabilityEvidenceAssessment", "能力证据评估", "把用户已有能力证据映射到目标岗位要求并区分优势、未知和未证实项", ["capability_evidence_mapping"], {"profile": profile, "role_family_matrix": prior("岗位要求矩阵"), "opportunity_inventory": _field("array", "可选的具体岗位机会", "prior_skill_output", required=False)}, {"evidence_matrix": _out("array", "要求、证据、证据强度、未知项和冲突")}, ["opportunity-portfolio-prioritization", "exploration-experiment-design"], excludes=["制定完整学习计划", "采集新的能力证据"]),
        _candidate("opportunity_portfolio_prioritization", "OpportunityPortfolioPrioritization", "机会组合优先级", "按匹配度、成长性、可进入性、偏好和证据质量比较机会组合", ["opportunity_fit_scoring"], {"profile": profile, "industry_landscape": prior("行业地图"), "role_family_matrix": prior("岗位族矩阵"), "opportunity_inventory": prior("机会池"), "evidence_matrix": prior("能力证据矩阵")}, {"ranked_portfolio": _out("array", "带分项依据、置信度和敏感性的优先机会组合")}, ["user_decision", "exploration-experiment-design"], steps=5),
        _candidate("exploration_experiment_design", "ExplorationExperimentDesign", "探索实验设计", "针对高优先级方向的关键不确定性设计低成本、可判定的验证任务", ["exploration_experiment_design"], {"ranked_portfolio": prior("优先机会组合"), "evidence_matrix": prior("能力证据矩阵"), "time_budget": _field("string", "可用于探索的时间预算", "state")}, {"validation_experiments": _out("array", "任务、假设、成功信号、成本、期限和决策规则")}, ["user_decision"], excludes=["生成长期课程表", "保证求职结果"]),
    ]


class MockSynthesisModel:
    """Deterministic offline model used for tests and first-run Web UI demos."""

    def complete_json(self, *, system: str, user: str) -> Any:
        del system
        if user.startswith("Analyze the user's needs"):
            return deepcopy(NEEDS)
        if user.startswith("Convert the analyzed needs"):
            return _task_map()
        if user.startswith("Synthesize reusable SkillTool"):
            return {"candidates": _candidates()}
        if user.startswith("Review this SkillTool portfolio"):
            candidates = _candidates()
            return {
                "decisions": [
                    {"candidate_ids": [item["skill_id"]], "action": "keep", "reason": "业务目标和输出消费边界独立", "result_ids": [item["skill_id"]]}
                    for item in candidates
                ],
                "final_candidates": candidates,
                "portfolio_notes": ["数据采集类和个人决策类 SkillTool 已分离", "所有输出均有下游消费者"],
            }
        raise ValueError("unknown mock synthesis stage")
