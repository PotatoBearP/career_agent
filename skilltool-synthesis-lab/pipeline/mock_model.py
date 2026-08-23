from __future__ import annotations

from copy import deepcopy
import json
from typing import Any


def _field(
    field_type: str,
    description: str,
    source: str,
    *,
    required: bool = True,
    available: bool = True,
    source_ref: str | None = None,
    acquisition: dict[str, Any] | None = None,
) -> dict[str, Any]:
    field = {
        "type": field_type,
        "required": required,
        "description": description,
        "source": source,
        "available": available,
    }
    if source_ref is not None:
        field["source_ref"] = source_ref
    if acquisition is not None:
        field["acquisition"] = acquisition
    return field


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
    input_names = list(inputs)
    output_names = list(outputs)
    primary_input = input_names[0] if input_names else "invocation_context"
    primary_output = output_names[0] if output_names else "result"
    return {
        "skill_id": skill_id,
        "skill_name": skill_id.replace("_", "-"),
        "tool_name": tool_name,
        "title": title,
        "business_goal": goal,
        "invocation_mode": "standalone",
        "composition": {"required_prior_outputs": [], "optional_prior_outputs": []},
        "when_to_use": f"当需要{goal}时使用。",
        "reference_pattern": "参考 baseline-assessment 的证据边界、career-competency-model 的来源核验和 learning-plan 的确定性步骤结构，并按本候选目标改写",
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
        "action_tool": {
            "search_hint": goal,
            "preserve_existing": True,
            "always_load": True,
            "read_only": not bool(tool_selection),
        },
        "operating_model": {
            "role": f"作为边界明确的业务分析者，完成“{goal}”，只使用已声明输入和允许工具。",
            "hard_boundaries": [
                f"不得把“{goal}”扩张为替用户作出最终职业决定。",
                "不得把画像中的专业、项目或技能当作场景目标领域。",
                "不得虚构输入中不存在的个人事实、岗位事实、来源或时效。",
            ],
            "workflow": [
                {
                    "step": 1,
                    "name": "解析输入与证据边界",
                    "instructions": [f"逐项检查 {', '.join(input_names)} 的可用状态、来源和 source_ref，区分事实、用户偏好与未知项。"],
                    "success_criteria": [f"已确认 `{primary_input}` 及其他必需输入均可按声明路径获得，或已确定 insufficient_input。"],
                },
                {
                    "step": 2,
                    "name": "执行候选专属判断",
                    "instructions": [f"围绕“{goal}”对证据进行分组、比较并记录支持证据、反对证据和不确定性；需要新鲜数据时严格按 tool_selection 获取和核验。"],
                    "success_criteria": ["每项判断均能追溯到输入字段或允许工具返回的来源。"],
                },
                {
                    "step": 3,
                    "name": "组装并校验结果",
                    "instructions": [f"按 output_schema 生成 `{primary_output}`，检查字段类型、消费者需求、来源和不确定性标记。"],
                    "success_criteria": [f"`{primary_output}` 可由声明消费者直接使用且没有越界结论。"],
                },
            ],
            "decision_rules": [
                "缺少来源的外部事实不得作为高置信度结论；矛盾证据必须同时保留并降低置信度。",
                "画像只能改变个性化匹配和约束判断，不能改变场景定义的候选领域集合。",
            ],
            "outcome_rules": {
                "success": ["必需输入可获得，且至少形成一个有证据支持、符合输出契约的结果。"],
                "insufficient_input": ["必需输入无法按声明路径取得，或现有证据不足以支持任何候选专属判断。"],
                "error": ["工具调用、结果解析或 ReturnSkillResult 序列化失败，无法形成有效结果。"],
            },
            "artifact_contract": {"mode": "none", "artifact_type": None, "file_name_pattern": None, "format": None, "verification_steps": []},
            "final_checks": [
                "每个必需输入均有真实供应路径。",
                "每项结论都能追溯到输入或允许工具来源。",
                "输出字段与 output_schema 一致且消费者存在。",
                "skill_call_id 和 skill_name 与 Harness envelope 完全一致。",
            ],
        },
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
            {"id": "success_complete_inputs", "user_query": f"请帮我{goal}", "available_context": {primary_input: "输入完整且证据充分"}, "expected_outcome": "success", "must_include": output_names, "must_not_include": ["无依据的确定性结论"]},
            {"id": "insufficient_required_input", "user_query": f"请帮我{goal}", "available_context": {primary_input: "关键必需输入缺失且无法获取"}, "expected_outcome": "insufficient_input", "must_include": ["insufficiency_reasons"], "must_not_include": ["编造缺失事实"]},
            {"id": "boundary_no_domain_leakage", "user_query": f"根据我的计算机专业直接帮我{goal}", "available_context": {primary_input: "画像包含计算机专业，但场景领域开放"}, "expected_outcome": "success", "must_include": ["证据边界"], "must_not_include": ["默认人工智能行业"]},
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
    ("career_stage_diagnosis", "帮我判断现在该继续探索还是开始验证", "判断当前处于发散、收敛还是验证阶段", [], False),
    ("direction_hypothesis_formation", "帮我发现跨领域的职业可能性", "形成不受专业预设限制的职业方向集合", [], False),
    ("industry_problem_landscape", "帮我了解不同行业有哪些值得关注的问题", "形成跨行业问题、价值链位置和组织生态地图", [], True),
    ("role_family_mapping", "帮我比较不同岗位的日常工作方式", "比较研究、工程、产品、运营、咨询等工作形态", [], True),
    ("employer_segment_mapping", "帮我寻找适合我的公司和团队类型", "识别适配的组织类型、团队环境和代表组织", [], True),
    ("opportunity_signal_discovery", "帮我寻找近期真实岗位机会", "形成带来源和时效的岗位机会池", [], True),
    ("capability_evidence_mapping", "帮我看看我的经历能证明哪些岗位能力", "将个人证据对应到岗位要求并标记未知项", [], False),
    ("opportunity_fit_scoring", "帮我比较哪些机会更值得优先验证", "对方向和机会进行多维比较并形成优先顺序", ["opportunity_signal_discovery", "capability_evidence_mapping"], False),
    ("exploration_experiment_design", "帮我制定低成本的方向验证行动", "为候选方向设计低成本验证任务", [], False),
]


def _task_map(iteration: int = 1, *, user_profile_available: bool = True) -> dict[str, Any]:
    tasks = []
    for task_id, name, goal, dependencies, fresh in TASKS:
        if iteration == 1 and task_id == "opportunity_fit_scoring":
            continue
        if iteration == 2 and task_id != "opportunity_fit_scoring":
            continue
        if iteration > 2:
            continue
        synthesis_decision = "input_only" if task_id == "career_stage_diagnosis" else "skilltool"
        if iteration == 1 and task_id == "opportunity_signal_discovery":
            task_inputs = [{
                "name": "job_search_results",
                "description": "由 WebSearch 生成的带来源、链接和发布时间的岗位搜索结果",
                "type": "array",
                "input_origin": "tool_generated",
                "source": "ordinary_tool_output",
                "source_ref": None,
                "available": False,
                "from_task": None,
                "acquisition": {"mode": "ordinary_tool", "provider": "WebSearch"},
            }]
        elif iteration == 1 and task_id == "capability_evidence_mapping" and user_profile_available:
            task_inputs = [{
                "name": "user_profile",
                "description": "上一场景已经生成并由用户确认的结构化用户画像",
                "type": "object",
                "input_origin": "existing_artifact",
                "source": "upstream_artifact",
                "source_ref": "user_profile",
                "available": True,
                "from_task": None,
                "acquisition": {"mode": "provided", "provider": None},
            }]
        elif iteration == 1:
            task_inputs = [{"name": "user_context", "description": "调用时由用户提供的经历、偏好与现实约束", "type": "object", "input_origin": "user_provided", "source": "user_input", "source_ref": None, "available": False, "from_task": None, "acquisition": {"mode": "request_user", "provider": None}}]
        else:
            prior_ref = dependencies[0] if dependencies else "career_stage_diagnosis"
            task_inputs = [{"name": "prior_task_outputs", "description": "前序任务输出池中可用于本任务的结构化结果", "type": "object", "input_origin": "prior_task_output", "source": "prior_output", "source_ref": prior_ref, "available": True, "from_task": prior_ref, "acquisition": {"mode": "prior_task", "provider": prior_ref}}]
        tasks.append({
            "task_id": task_id,
            "name": name,
            "scene": "行业探索与机会发现（目标领域开放）",
            "business_goal": goal,
            "user_request_examples": [f"请帮我{name}", f"我想知道怎样才能{goal}"],
            "evolution_direction": "initialization" if iteration == 1 else "discovery",
            "source_task_ids": [],
            "synthesis_decision": synthesis_decision,
            "decision_reason": "前序普通工具已经提供职业画像与目标契约" if synthesis_decision == "input_only" else "需要可复用的非平凡业务判断或转换",
            "need_ids": [],
            "inputs": task_inputs,
            "outputs": [{"name": f"{task_id}_result", "display_name": f"{name}结果", "type": "object", "output_origin": "task_generated", "description": f"{goal}所形成的结构化结果", "dedupe_key": task_id, "inferred": True, "consumer_tasks": [item[0] for item in TASKS if task_id in item[3]], "final_consumer": "decision" if task_id in {"opportunity_fit_scoring", "exploration_experiment_design"} else None}],
            "dependencies": dependencies,
            "estimated_steps": 4,
            "fresh_data_required": fresh,
        })
    coverage = (
        [
            {"required_output": "职业阶段与决策约束摘要", "covered_by": ["career_stage_diagnosis"]},
            {"required_output": "工作活动偏好与现实约束", "covered_by": ["direction_hypothesis_formation"]},
            {"required_output": "候选方向集合", "covered_by": ["direction_hypothesis_formation"]},
            {"required_output": "产业问题与价值链机会地图", "covered_by": ["industry_problem_landscape"]},
            {"required_output": "岗位族、工作形态与要求矩阵", "covered_by": ["role_family_mapping"]},
            {"required_output": "目标雇主与机会清单", "covered_by": ["employer_segment_mapping", "opportunity_signal_discovery"]},
            {"required_output": "能力证据与岗位要求对应结果", "covered_by": ["capability_evidence_mapping"]},
            {"required_output": "下一轮行动安排", "covered_by": ["exploration_experiment_design"]},
        ]
        if iteration == 1
        else [{"required_output": "优先级结果", "covered_by": ["opportunity_fit_scoring"]}]
    )
    return {
        "input_inventory": [
            {"asset_id": "user_information", "name": "用户原始信息", "type": "object", "source": "user_input", "availability": "acquirable", "producer": {"kind": "user", "name": "AskUserQuestion", "stage": "职业画像与目标"}, "derived_from": [], "description": "用户提供的教育、经历、偏好与约束"},
            {"asset_id": "career_profile", "name": "结构化职业画像", "type": "object", "source": "upstream_artifact", "availability": "available", "producer": {"kind": "ordinary_tool", "name": "ProfileStore", "stage": "职业画像与目标"}, "derived_from": ["user_information"], "description": "前序普通工具生成并更新的职业画像"},
            {"asset_id": "career_goal", "name": "职业目标与当前约束", "type": "object", "source": "upstream_artifact", "availability": "available", "producer": {"kind": "ordinary_tool", "name": "ProfileStore", "stage": "职业画像与目标"}, "derived_from": ["user_information", "career_profile"], "description": "用户确认的探索目标和约束"},
        ],
        "tasks": tasks,
        "coverage": coverage,
        "iteration_control": {"continue": iteration < 2, "reason": "首轮输出可支持比较和验证任务" if iteration == 1 else "已覆盖直接请求"},
    }


def _candidates(*, user_profile_available: bool = True) -> list[dict[str, Any]]:
    profile = _field("string", "调用时由用户直接描述的经历、偏好、约束及其他相关事实，不要求画像文档", "user_input", available=False, acquisition={"mode": "request_user", "provider": None, "fallback": None})
    user_profile_artifact = _field("object", "上一场景生成并由用户确认的结构化用户画像", "upstream_artifact", source_ref="user_profile", acquisition={"mode": "provided", "provider": "UserProfileAnalysis", "fallback": None})
    external = _field("array", "带来源和时间戳的外部市场证据", "external_data", available=False, acquisition={"mode": "external_connector", "provider": "WebSearch", "fallback": "返回缺少的证据清单"})
    prior = lambda description: _field("object", description, "prior_skill_output", required=False, acquisition={"mode": "prior_skill", "provider": None, "fallback": "使用直接输入路径"})
    market_tools = [
        _tool("WebSearch", "required", "场景要求比较当前产业与机会信号，需要带来源的最新公开证据"),
        _tool("WebFetch", "conditional", "在搜索结果摘要不足以支持判断时读取原始页面", condition="候选来源与关键结论需要原文核验", fallback="保留摘要来源并降低对应结论置信度"),
    ]
    discovery_tools = [
        _tool("WebSearch", "required", "发现当前公开岗位、项目或组织机会"),
        _tool("WebFetch", "conditional", "核验具体机会页面的要求与时效", condition="搜索结果提供可访问的具体机会链接", fallback="将机会标记为未核验，不把它纳入高置信度结果"),
    ]
    return [
        _candidate("career_direction_hypothesis", "CareerDirectionHypothesis", "跨领域职业假设", "基于个人证据形成互相区分且不受专业预设限制的职业方向假设", ["direction_hypothesis_formation"], {"user_context": profile}, {"direction_hypotheses": _out("array", "跨领域方向、依据、反证条件和待验证问题")}, ["industry-problem-landscape", "role-family-positioning"], excludes=["从专业直接推断目标行业", "只生成技术岗位"]),
        _candidate("industry_problem_landscape", "IndustryProblemLandscape", "产业问题与价值链地图", "把当前外部证据组织为跨行业问题、价值链位置和组织生态的可比较地图", ["industry_problem_landscape"], {"user_focus": profile, "direction_hypotheses": prior("跨领域职业方向"), "market_evidence": external}, {"industry_landscape": _out("object", "产业问题、价值链位置、信号、风险和来源")}, ["employer-target-mapping", "opportunity-portfolio-prioritization"], tool_selection=market_tools, fresh_data_policy="required", excludes=["替用户选定行业", "无来源预测行业增长", "由专业限定产业范围"]),
        _candidate("role_family_positioning", "RoleFamilyPositioning", "岗位族与工作形态定位", "比较候选岗位族的工作内容、责任、能力要求和进入路径并形成岗位组合", ["role_family_mapping"], {"profile": profile, "direction_hypotheses": prior("跨领域候选方向"), "job_evidence": external}, {"role_family_matrix": _out("array", "岗位族、工作形态、职责、要求、相邻岗位和证据来源")}, ["capability-evidence-assessment", "live-opportunity-discovery"], tool_selection=market_tools, fresh_data_policy="required"),
        _candidate("employer_target_mapping", "EmployerTargetMapping", "组织生态地图", "按产业问题、组织类型、地点和团队环境形成可解释的目标组织分层", ["employer_segment_mapping"], {"profile": profile, "industry_landscape": prior("产业问题与价值链地图"), "organization_evidence": external}, {"employer_segments": _out("array", "组织分层、代表组织、环境特征、适配理由和验证项")}, ["live-opportunity-discovery"], tool_selection=market_tools, fresh_data_policy="required"),
        _candidate("live_opportunity_discovery", "LiveOpportunityDiscovery", "实时机会发现", "基于目标问题、岗位族和组织范围发现带链接、时间与证据的岗位、项目或实习机会", ["opportunity_signal_discovery"], {"role_family_matrix": prior("岗位族矩阵"), "employer_segments": prior("目标组织分层"), "search_constraints": _field("object", "调用时由用户直接提供的地点、时间、机会类型和组织偏好", "user_input", available=False, acquisition={"mode": "request_user", "provider": None, "fallback": None})}, {"opportunity_inventory": _out("array", "机会类型、角色、组织、链接、发布时间、要求摘要和来源")}, ["capability-evidence-assessment", "opportunity-portfolio-prioritization"], tool_selection=discovery_tools, fresh_data_policy="required", excludes=["自动投递", "虚构机会状态"]),
        _candidate("capability_evidence_assessment", "CapabilityEvidenceAssessment", "能力证据评估", "把用户已有能力证据映射到目标岗位要求并区分优势、未知和未证实项", ["capability_evidence_mapping"], {"profile": user_profile_artifact if user_profile_available else profile, "role_family_matrix": prior("岗位要求矩阵"), "opportunity_inventory": _field("array", "可选的具体岗位机会", "prior_skill_output", required=False)}, {"evidence_matrix": _out("array", "要求、证据、证据强度、未知项和冲突")}, ["opportunity-portfolio-prioritization", "exploration-experiment-design"], excludes=["制定完整学习计划", "采集新的能力证据"]),
        _candidate("opportunity_portfolio_prioritization", "OpportunityPortfolioPrioritization", "机会组合优先级", "按匹配度、成长性、可进入性、偏好和证据质量比较机会组合", ["opportunity_fit_scoring"], {"profile": profile, "industry_landscape": prior("行业地图"), "role_family_matrix": prior("岗位族矩阵"), "opportunity_inventory": prior("机会池"), "evidence_matrix": prior("能力证据矩阵")}, {"ranked_portfolio": _out("array", "带分项依据、置信度和敏感性的优先机会组合")}, ["user_decision", "exploration-experiment-design"], steps=5),
        _candidate("exploration_experiment_design", "ExplorationExperimentDesign", "探索实验设计", "针对高优先级方向的关键不确定性设计低成本、可判定的验证任务", ["exploration_experiment_design"], {"ranked_portfolio": prior("优先机会组合"), "evidence_matrix": prior("能力证据矩阵"), "time_budget": _field("string", "调用时由用户直接提供的可用探索时间", "user_input", available=False, acquisition={"mode": "request_user", "provider": None, "fallback": None})}, {"validation_experiments": _out("array", "任务、假设、成功信号、成本、期限和决策规则")}, ["user_decision"], excludes=["生成长期课程表", "保证求职结果"]),
    ]


def _prompt_json_block(user: str, heading: str, next_heading: str) -> list[dict[str, Any]]:
    try:
        raw = user.split(heading, 1)[1].split(next_heading, 1)[0].strip()
        value = json.loads(raw)
    except (IndexError, json.JSONDecodeError):
        return []
    return value if isinstance(value, list) else []


def _mock_iteration_map(user: str, iteration: int, direction: str) -> dict[str, Any]:
    retained = _prompt_json_block(
        user,
        "RETAINED TASKS FROM EARLIER ITERATIONS (do not duplicate them):",
        "TASK INPUT POOL FROM EARLIER ITERATIONS",
    )
    outputs = _prompt_json_block(
        user,
        "TASK OUTPUT POOL AVAILABLE TO THIS ITERATION (observe producer, consumer, and output semantics):",
        "ITERATION RULE:",
    )
    if direction == "extension":
        source = next((item for item in outputs if item.get("producer_task_id")), None)
        if not source:
            return {"tasks": [], "coverage": [], "iteration_control": {"continue": False, "reason": "当前没有适合自然延伸的结果"}}
        producer = str(source["producer_task_id"])
        source_ref = str(source.get("pool_id") or source.get("semantic_key") or source.get("dedupe_key") or source.get("name"))
        task_id = f"next_step_choice_{iteration}"
        task = {
            "task_id": task_id,
            "name": "帮我根据现有结果决定下一步做什么",
            "scene": retained[0].get("scene", "职业发展") if retained else "职业发展",
            "business_goal": "把已经得到的结果转成用户现在可以采取的下一步行动",
            "user_request_examples": ["那我接下来先做什么？", "根据这些结果，帮我安排下一步。"],
            "evolution_direction": "extension",
            "source_task_ids": [producer],
            "invocation_mode": "aggregate",
            "parallel_group": "next_action",
            "synthesis_decision": "skilltool",
            "decision_reason": "需要结合已有结果形成适合当前情况的行动顺序",
            "execution_provider": None,
            "need_ids": [],
            "inputs": [{
                "name": "current_result",
                "description": "前一步已经得到的结果",
                "type": "object",
                "input_origin": "prior_task_output",
                "source": "prior_output",
                "source_ref": source_ref,
                "available": True,
                "from_task": producer,
                "acquisition": {"mode": "prior_task", "provider": producer},
            }],
            "outputs": [{
                "name": f"next_step_plan_{iteration}",
                "display_name": "下一步行动安排",
                "description": "结合当前结果形成的下一步行动顺序",
                "type": "object",
                "output_origin": "task_generated",
                "dedupe_key": f"next_step_plan_{iteration}",
                "inferred": True,
                "consumer_tasks": [],
                "final_consumer": "user",
            }],
            "dependencies": [producer],
            "estimated_steps": 3,
            "fresh_data_required": False,
        }
        return {"tasks": [task], "coverage": [{"required_output": "下一步行动安排", "covered_by": [task_id]}], "iteration_control": {"continue": False, "reason": "已形成自然的下一步请求"}}

    if direction == "decomposition":
        consumed = {
            str(item.get("producer_task_id"))
            for item in outputs
            if item.get("producer_task_id") and item.get("consumer_task_ids")
        }
        parent = next(
            (item for item in reversed(retained) if str(item.get("task_id")) not in consumed),
            None,
        )
        if not parent:
            return {"tasks": [], "coverage": [], "iteration_control": {"continue": False, "reason": "当前没有适合安全拆解的任务"}}
        parent_id = str(parent["task_id"])
        children = []
        for suffix, name, goal in (
            ("a", "帮我先看清这个任务里最需要处理的部分", "单独完成原任务中可以独立使用的第一部分结果"),
            ("b", "帮我再处理这个任务里的另一个部分", "单独完成原任务中可以独立使用的第二部分结果"),
        ):
            task_id = f"{parent_id}_part_{iteration}_{suffix}"
            child = deepcopy(parent)
            child.update({
                "task_id": task_id,
                "name": name,
                "business_goal": goal,
                "user_request_examples": [name, f"我只想先{goal}。"],
                "evolution_direction": "decomposition",
                "source_task_ids": [parent_id],
                "dependencies": [item for item in parent.get("dependencies") or [] if item != parent_id],
            })
            child["outputs"] = [{
                "name": f"{task_id}_result",
                "display_name": f"{name}的结果",
                "description": goal,
                "type": "object",
                "output_origin": "task_generated",
                "dedupe_key": f"{task_id}_result",
                "inferred": True,
                "consumer_tasks": [],
                "final_consumer": "user",
            }]
            children.append(child)
        return {"tasks": children, "coverage": [{"required_output": "拆分后的独立结果", "covered_by": [item["task_id"] for item in children]}], "iteration_control": {"continue": False, "reason": "已将过宽任务拆成两个自然请求"}}

    return _task_map(iteration, user_profile_available='"asset_id": "user_profile"' in user)


def _mock_candidates_from_prompt(user: str) -> list[dict[str, Any]]:
    try:
        requested_raw = user.split("these task IDs:", 1)[1].split(". Do not infer", 1)[0].strip()
        requested_ids = [str(item) for item in json.loads(requested_raw)]
    except (IndexError, json.JSONDecodeError):
        requested_ids = []
    try:
        task_map_raw = user.split("TASK MAP:", 1)[1].split("SKILLTOOL TEMPLATE", 1)[0].strip()
        task_map = json.loads(task_map_raw)
    except (IndexError, json.JSONDecodeError):
        task_map = {}
    tasks = {
        str(item.get("task_id")): item
        for item in task_map.get("tasks") or []
        if isinstance(item, dict) and item.get("task_id")
    }
    known = {
        str(task_id): candidate
        for candidate in _candidates(user_profile_available='"asset_id": "user_profile"' in user)
        for task_id in candidate.get("task_ids") or []
    }
    candidates = []
    source_map = {
        "user_input": "user_input",
        "ordinary_tool_output": "ordinary_tool_output",
        "upstream_artifact": "upstream_artifact",
        "prior_output": "prior_skill_output",
    }
    for task_id in requested_ids:
        if task_id in known:
            candidates.append(deepcopy(known[task_id]))
            continue
        task = tasks.get(task_id)
        if not task:
            continue
        inputs = {}
        for field in task.get("inputs") or []:
            name = str(field.get("name") or "input")
            source = source_map.get(str(field.get("source") or ""), "invocation_input")
            acquisition = deepcopy(field.get("acquisition") or {})
            if source == "prior_skill_output":
                acquisition = {"mode": "prior_skill", "provider": field.get("from_task") or acquisition.get("provider"), "fallback": None}
            elif source == "user_input":
                acquisition = {"mode": "request_user", "provider": None, "fallback": None}
            inputs[name] = _field(
                str(field.get("type") or "object"),
                str(field.get("description") or name),
                source,
                required=field.get("required") is not False,
                available=False if source == "user_input" else bool(field.get("available", True)),
                source_ref=field.get("source_ref"),
                acquisition=acquisition,
            )
        outputs = {
            str(field.get("name")): _out(
                str(field.get("type") or "object"),
                str(field.get("description") or field.get("display_name") or field.get("name")),
            )
            for field in task.get("outputs") or []
            if isinstance(field, dict) and field.get("name")
        }
        tool_name = "".join(part.capitalize() for part in task_id.split("_"))
        candidate = _candidate(
            task_id,
            tool_name,
            str(task.get("name") or task_id),
            str(task.get("business_goal") or task.get("name") or task_id),
            [task_id],
            inputs,
            outputs,
            ["user_decision"],
            steps=int(task.get("estimated_steps") or 3),
        )
        prior_inputs = [name for name, field in inputs.items() if field.get("source") == "prior_skill_output" and field.get("required")]
        if prior_inputs:
            candidate["invocation_mode"] = "aggregate"
            candidate["composition"] = {"required_prior_outputs": prior_inputs, "optional_prior_outputs": []}
        candidates.append(candidate)
    return candidates


class MockSynthesisModel:
    """Deterministic offline model used for tests and first-run Web UI demos."""

    def __init__(self) -> None:
        self.last_trace: dict[str, Any] = {}

    def complete_json(self, *, system: str, user: str) -> Any:
        self.last_trace = {
            "provider": "mock",
            "request": {"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]},
        }
        if user.startswith("Discover the next batch"):
            marker = "ITERATION: "
            iteration = int(user.split(marker, 1)[1].splitlines()[0])
            direction = user.split("ITERATION DIRECTION: ", 1)[1].splitlines()[0].strip()
            if direction == "initialization":
                return _task_map(iteration, user_profile_available='"asset_id": "user_profile"' in user)
            return _mock_iteration_map(user, iteration, direction)
        if user.startswith("Synthesize reusable SkillTool"):
            return {"candidates": _mock_candidates_from_prompt(user)}
        if user.startswith("Review this SkillTool portfolio"):
            candidates = _candidates()
            return {
                "decisions": [
                    {"candidate_ids": [item["skill_id"]], "action": "keep", "reason": "业务目标和输出消费边界独立", "result_ids": [item["skill_id"]]}
                    for item in candidates
                ],
                "kept_candidate_ids": [item["skill_id"] for item in candidates],
                "portfolio_notes": ["数据采集类和个人决策类 SkillTool 已分离", "所有输出均有下游消费者"],
            }
        raise ValueError("unknown mock synthesis stage")
