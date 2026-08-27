from __future__ import annotations

import json
from typing import Any

from .reference_skills import load_reference_harness_tool_pack, load_reference_skill_pack, reference_design_principles


SYSTEM_PROMPT = """You are a SkillTool portfolio architect. Design reusable, standalone AI capabilities from a reference profile and a reference business scenario. These inputs may be free-form natural language; do not assume they follow a JSON schema. A SkillTool is a bounded business capability executed by a child model through an external API. It must not depend on an application implementation.

Rules:
1. Return strict JSON only. Never wrap JSON in Markdown. Never use ellipses (`...`), comments, pseudo-JSON, or placeholder literals; represent illustrative context as ordinary strings so the entire response parses with a standard JSON parser.
2. Preserve uncertainty and evidence provenance. Do not invent personal facts or live market facts.
3. Design a menu of independently invocable capabilities for a scenario, not a mandatory end-to-end workflow. Parallel capabilities are the default; composition is optional.
4. Build an explicit input inventory before designing capabilities. Reuse contracted upstream artifacts even when their producer was an ordinary tool and therefore was not synthesized as a SkillTool.
5. Every task input must use exactly one truthful provisioning class: user-provided input, an existing ordinary-tool output, an existing scenario artifact, or a prior task output. Every input and output declares a concrete JSON type.
6. Every output must have an explicit schema and at least one truthful consumer. The user or an external system is a valid consumer; never invent a downstream SkillTool merely to create a chain.
7. A SkillTool owns one meaningful business decision or transformation. Reject trivial formatting/retrieval wrappers and split multi-decision mega-skills. Tasks already handled by an ordinary tool remain visible as input producers but must not become SkillTools.
8. SkillTools are portable: no main-program imports, database assumptions, UI state, route names, or internal service calls.
9. Profile and scenario are strictly decoupled. The scenario defines the problem space. The profile only supplies personal evidence and constraints inside that space. Never infer a target industry, role, or scenario domain from education, major, projects, or skills.
10. If the scenario domain is open, keep exploration cross-domain or request an explicit domain; never silently default to the profile's background.
11. Auxiliary tools may only come from the supplied non-Skill tool catalog. Select none by default. Every selected tool needs a required, optional, or conditional usage mode and a concrete reason. Conditional tools need a condition; optional tools need a fallback.
12. Never select Skill, discover_skills, ReturnSkillResult, a generated SkillActionTool, or another recursive Skill entry as an auxiliary tool.
13. Use snake_case IDs and PascalCase tool names.
14. A standalone SkillTool must be runnable from provided inputs, upstream artifacts, user input, or ordinary tools. Prior SkillTool outputs may enrich it only as optional inputs.
15. Only an explicitly aggregate capability may require prior SkillTool outputs, and aggregate capabilities must remain a minority of the portfolio."""


def _payload(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2)


def available_tool_catalog(tool_catalog: dict[str, Any]) -> dict[str, Any]:
    """Return only implemented, synthesis-selectable tools and their dependency policy.

    Exclusion/audit records deliberately stay out of model prompts so an MCP or
    recursive tool name cannot be mistaken for an available child tool.
    """
    return {
        "catalog_version": tool_catalog.get("catalog_version"),
        "selection_policy": tool_catalog.get("selection_policy") or {},
        "tools": [
            {
                "name": item.get("name"),
                "category": item.get("category"),
                "description": item.get("description"),
                "availability": item.get("availability"),
                "prerequisite_status": item.get("prerequisite_status"),
                "prerequisites": item.get("prerequisites") or [],
                "typical_call_order": item.get("typical_call_order"),
            }
            for item in tool_catalog.get("tools") or []
            if isinstance(item, dict)
            and item.get("selectable_for_skilltool") is True
            and item.get("implementation_status") != "missing"
        ],
    }


def task_synthesis_prompt(
    profile: Any,
    scenario: Any,
    input_validation: dict[str, Any],
    *,
    iteration: int,
    retained_tasks: list[dict[str, Any]],
    input_pool: list[dict[str, Any]],
    output_pool: list[dict[str, Any]],
    available_outputs: list[dict[str, Any]],
    tool_catalog: dict[str, Any],
    iteration_direction: str = "discovery",
) -> str:
    first_iteration = iteration == 1
    visible_inventory = [
        item
        for item in input_validation.get("input_inventory") or []
        if isinstance(item, dict) and item.get("source") == "upstream_artifact"
    ]
    available_tools = available_tool_catalog(tool_catalog)["tools"]
    task_count_rule = (
        "Return 8-10 distinct initialization tasks. Fewer than 8 is incomplete coverage; more than 10 is likely over-fragmented."
        if iteration_direction == "initialization"
        else "Return 0-8 new tasks; an empty array is valid when no justified task exists."
    )
    iteration_context = "" if first_iteration else f"""
RETAINED TASKS FROM EARLIER ITERATIONS (do not duplicate them):
{_payload(retained_tasks)}

TASK INPUT POOL FROM EARLIER ITERATIONS (observe consumer, source, and input semantics):
{_payload(input_pool)}

TASK OUTPUT POOL AVAILABLE TO THIS ITERATION (observe producer, consumer, and output semantics):
{_payload(output_pool or available_outputs)}
"""
    source_rule = (
        "This is the first iteration. Profile and scenario guide which capabilities belong in scope, but are not required runtime artifacts. "
        "Inputs may be inferred user input, outputs produced by a named tool in AVAILABLE ORDINARY TOOLS, or existing artifacts in EXISTING SCENARIO ARTIFACTS. "
        "Prior task outputs and task dependencies are forbidden in the first iteration."
        if first_iteration else
        "Derive only genuinely new next-level tasks. Inputs may additionally reference a concrete entry in TASK OUTPUT POOL as prior_task_output. "
        "Do not repeat earlier goals or outputs."
    )
    direction_rule = {
        "initialization": "INITIALIZATION COVERAGE ONLY. Build a realistic first pool of 8-10 complete, user-recognizable tasks directly supported by inferred user inputs, available ordinary tools, or existing scenario artifacts. Cover the scenario end to end with distinct requests a user could make at different moments: exploring possible directions; understanding real daily work, deliverables and collaboration; understanding entry requirements and paths; finding and verifying real opportunities; comparing roles or opportunities supplied by the user; comparing personal evidence with role requirements; preparing conversations or other evidence-gathering activities; and planning practical direction-validation actions. Add another scenario-grounded intent only when it is genuinely distinct. Do not bundle these into a few mega-tasks, but also do not expose internal steps merely to reach the count. Each task must stand alone, use evolution_direction initialization, and keep source_task_ids empty. Do not use prior task outputs.",
        "discovery": "Discover complete user-recognizable tasks directly supported by invocation inputs, ordinary tools, or existing scenario artifacts.",
        "decomposition": "DECOMPOSITION REPLACEMENT ONLY. Inspect RETAINED TASKS for a task that is too broad or bundles multiple independently useful user outcomes. Replace that parent with at least two smaller tasks; the parent will be removed from the active pool. Every child must still be something a normal user would ask directly, must have a narrower outcome, must set evolution_direction to decomposition, and must name exactly one shared parent task ID in source_task_ids. Do not decompose a parent whose output is already consumed by another retained task, because removing it would break the input/output flow. Do not expose implementation steps such as extraction, mapping, scoring, or formatting as tasks. Return an empty tasks array when no safe, natural replacement is justified.",
        "extension": "EXTENSION ONLY. Follow one or more outputs already present in TASK OUTPUT POOL and write the next request exactly as a normal user would continue the conversation. A valid extension may continue from one task output or combine several task outputs. Each proposed task must set evolution_direction to extension, name every producer in source_task_ids, and consume at least one prior_output input. Prefer plain requests such as ‘这些岗位里哪个更适合我’, ‘帮我排一下先投哪些’, ‘接下来一周我先做什么’, or ‘帮我看看这条招聘靠不靠谱’. Do not name the task with analyst or methodology language such as 可验证、验证闭环、假设、证据链、置信度、评估矩阵、框架、建模、映射、归因 or 决策备忘录. Those ideas may remain internal workflow details, but must not appear in the task name, business goal, or user request examples. Do not create a technical aggregation or report-merging task. It is valid to return no tasks when no natural continuation exists.",
    }.get(iteration_direction, "Discover genuinely new user-recognizable tasks.")
    return f"""Discover the next batch of modular tasks through iterative synthesis.

ITERATION: {iteration}
ITERATION DIRECTION: {iteration_direction}

REFERENCE PROFILE (personal evidence and constraints only):
{_payload(profile)}

REFERENCE SCENARIO (scope and boundary only):
{_payload(scenario)}

EXISTING SCENARIO ARTIFACTS (existing_artifact inputs must reference one of these asset_id values):
{_payload(visible_inventory)}

AVAILABLE ORDINARY TOOLS (tool_generated inputs must name one of these exact providers):
{_payload(available_tools)}
{iteration_context}

ITERATION RULE: {source_rule}
DIRECTION RULE: {direction_rule}
TASK COUNT RULE: {task_count_rule}

Return one top-level JSON object containing tasks and coverage:
{{
  "tasks": [
    {{
      "task_id": "task_snake_case",
      "name": "a concise user-facing service name in everyday language",
      "scene": "string",
      "business_goal": "the concrete result the user wants, phrased from the user's perspective",
      "user_request_examples": ["2-4 realistic first-person or direct requests a normal user might actually type"],
      "evolution_direction": "initialization|discovery|decomposition|extension",
      "source_task_ids": ["exactly one parent task ID for each decomposition child; exact producer task IDs for extension; empty for initialization/discovery"],
      "invocation_mode": "standalone|aggregate",
      "parallel_group": "independent capability family",
      "synthesis_decision": "skilltool|ordinary_tool|input_only",
      "decision_reason": "why a reusable SkillTool is or is not needed",
      "execution_provider": "exact ordinary tool name for ordinary_tool tasks; null otherwise",
      "need_ids": ["need_id"],
      "inputs": [
        {{"name": "string", "description": "stable input semantics", "type": "object|array|string|number|boolean", "input_origin": "user_provided|tool_generated|existing_artifact|prior_task_output", "source": "user_input|ordinary_tool_output|upstream_artifact|prior_output", "source_ref": "artifact asset_id, prior output pool_id/semantic_key, or null", "available": true, "from_task": null, "acquisition": {{"mode": "request_user|ordinary_tool|provided|prior_task", "provider": "exact tool name, prior task_id, or null"}}}}
      ],
      "outputs": [
        {{"name": "string", "display_name": "string", "description": "predicted output semantics used for task deduplication", "type": "object|array|string|number|boolean", "output_origin": "task_generated", "dedupe_key": "stable semantic key", "inferred": true, "consumer_tasks": ["task_id"], "final_consumer": "user|decision|another system|null"}}
      ],
      "dependencies": ["task_id"],
      "estimated_steps": 3,
      "fresh_data_required": false
    }}
  ],
  "coverage": [
    {{"required_output": "string", "covered_by": ["task_id"]}}
  ],
  "iteration_control": {{
    "continue": true,
    "reason": "why another output-enabled iteration is or is not useful"
  }}
}}

USER-EXPRESSIBILITY GATE:
- A task is a user-recognizable request, not an internal analysis step, ontology operation, or pipeline component.
- Start from what a normal user would ask for in one message. Use everyday service language such as “帮我看看我适合哪些方向”, “帮我比较这几个岗位”, or “我接下来四周先做什么”.
- Do not expose abstract implementation labels as tasks, including “映射”, “矩阵构建”, “假设生成”, “提取”, “模式分析”, “方向模式”, “建模”, “聚类”, “框架设计”, or “优先级计算”, unless that exact technical artifact is explicitly requested by the user. These may be internal workflow steps inside a broader user-facing task.
- Run the utterance test before returning each task: if its `name` and `business_goal` cannot naturally complete “我想请你……” or “帮我……”, rewrite, merge into a user-facing outcome, or remove it.
- `user_request_examples` is mandatory and must contain 2-4 distinct, realistic utterances without analyst jargon. It is evidence that the task passes the utterance test; do not merely paraphrase an abstract task label.
- For extension tasks, run the continuation test: every example must sound natural after “那接下来……”. Rewrite phrases such as “形成可验证假设”, “建立证据闭环”, or “输出置信度评估” into the concrete thing the user wants to compare, choose, check, prepare, or schedule.
- Prefer the smallest set that still satisfies the direction's explicit coverage and count rule. Never create analytical subtasks merely to increase the count. Keep inputs and outputs structured internally, but keep the task boundary and visible wording natural.

GENERALITY AND PARAMETERIZATION GATE:
- The scenario defines a reusable capability for many users. The reference profile is only one sample used to select relevant capabilities; none of its literal facts may become fixed task scope.
- Do not copy cities, regions, employers, schools, degrees, majors, technologies, personal projects, dates, numeric targets, time budgets, or other sample-user values into any task field, including input names and descriptions.
- Do not generalize a sample computer-science profile into “技术岗位”, “技术方向”, “算法”, “软件”, “开发”, or similar domain language. Use domain-neutral terms such as “目标岗位类型”, “目标方向”, and “用户指定领域”.
- Keep variable details as typed invocation inputs. Say “目标地区”, “用户指定的机会类型”, “希望保留的方向数量”, and “可用验证周期” rather than inserting sample values.
- A generic job-search task should be “帮我寻找符合我条件的真实岗位机会”, never “帮我寻找某几个具体城市的某类岗位”. A generic planning task must not hard-code a four-week duration or a fixed number of directions.
- Before returning, compare every user-visible task field against REFERENCE PROFILE and remove or parameterize any copied personal detail.

Follow TASK COUNT RULE exactly. In initialization, `coverage` must contain at least 8 distinct scenario outcomes and every proposed task ID must appear in at least one `covered_by` list. Every proposed task must predict at least one concrete output before it can be retained. Input descriptions and output `dedupe_key` values must describe stable semantics rather than wording so input, output, and task-description similarity can all be checked. Enforce the source/origin pairs exactly: user_input/user_provided, ordinary_tool_output/tool_generated, upstream_artifact/existing_artifact, prior_output/prior_task_output. User input may be inferred when it is reasonable to ask at invocation time. A tool-generated input must name an exact AVAILABLE ORDINARY TOOLS provider. An existing-artifact input must reference an asset_id from EXISTING SCENARIO ARTIFACTS. A prior-task-output input must reference TASK OUTPUT POOL and is forbidden in iteration 1. Every input and output must declare type; every output must use output_origin task_generated. Mark simple collection, CRUD, retrieval, and profile persistence tasks ordinary_tool or input_only; synthesize only non-trivial reusable decisions or transformations. Stay inside the reference scenario. Treat the task map as a user-facing capability menu, not an execution plan. A technical profile must not turn a generic scenario into a technology-specific scenario."""


def candidate_synthesis_prompt(
    profile: Any,
    scenario: Any,
    task_context: dict[str, Any],
    task_map: dict[str, Any],
    tool_catalog: dict[str, Any],
    skilltool_template: dict[str, Any],
) -> str:
    reference_pack = load_reference_skill_pack()
    harness_reference_pack = load_reference_harness_tool_pack()
    requested_tasks = [
        str(item.get("task_id")) for item in task_map.get("tasks") or []
        if item.get("synthesis_decision") == "skilltool"
    ]
    return f"""Synthesize reusable SkillTool candidates for the task map.

EXACT REQUEST: Return exactly {len(requested_tasks)} candidate(s), one for each and only these task IDs: {_payload(requested_tasks)}. Do not infer or synthesize any other capability from the wider scenario.

PROFILE:
{_payload(profile)}

SCENARIO:
{_payload(scenario)}

DIRECT REQUEST AND TASK OUTPUT CONTEXT:
{_payload(task_context)}

TASK MAP:
{_payload(task_map)}

SKILLTOOL TEMPLATE (every candidate must follow this structure):
{_payload(skilltool_template)}

AVAILABLE NON-SKILL PROJECT TOOLS:
{_payload(available_tool_catalog(tool_catalog))}

TOOL BOUNDARY: Select no tools by default and use only the smallest necessary subset of the catalog. Tools made specifically for Git, GitHub, PR hosting, or another named third-party website/service are forbidden even if mentioned elsewhere in the context; generic web, file, calculation, and interaction capabilities in the catalog remain available.

REFERENCE SKILL EXEMPLARS PROVIDED BY THE USER:
{_payload(reference_pack)}

REFERENCE DETERMINISTIC HARNESS TOOLS PROVIDED BY THE USER:
{_payload(harness_reference_pack)}

REFERENCE-DERIVED DESIGN PRINCIPLES:
{_payload(reference_design_principles())}

Use the references as structural and operational exemplars, not as domain content to copy. Match their specificity: tell a fresh child model exactly what to inspect, calculate, decide, write, verify, and return. Choose the closest pattern for each candidate (context-only assessment, current external research, or transformation of upstream artifacts), then adapt it to this candidate's own decision and tools.

Return:
{{
  "candidates": [
    {{
      "skill_id": "snake_case",
      "skill_name": "kebab-case",
      "tool_name": "PascalCase",
      "title": "string",
      "business_goal": "one non-trivial outcome",
      "invocation_mode": "standalone|aggregate",
      "composition": {{"required_prior_outputs": ["field_name"], "optional_prior_outputs": ["field_name"]}},
      "when_to_use": "string",
      "reference_pattern": "reference name and structural ideas adapted from it",
      "task_ids": ["task_id"],
      "scenario_binding": {{
        "domain_source": "scenario_only",
        "domain_mode": "open|explicit",
        "explicit_domains": ["only domains explicitly present in scenario"],
        "profile_role": "evidence_only"
      }},
      "scope": {{"includes": ["string"], "excludes": ["string"]}},
      "input_schema": {{
        "field_name": {{
          "type": "string|number|boolean|object|array",
          "required": true,
          "description": "string",
          "source": "profile|scenario|upstream_artifact|invocation_input|user_input|ordinary_tool_output|external_data|prior_skill_output",
          "source_ref": "input_inventory asset_id, prior output field, or null",
          "available": true,
          "acquisition": {{"mode": "provided|request_user|ordinary_tool|external_connector|prior_skill", "provider": "tool/skill name or null", "fallback": "string|null"}}
        }}
      }},
      "output_schema": {{
        "field_name": {{"type": "string|number|boolean|object|array", "description": "string"}}
      }},
      "output_consumers": ["user_decision|skill_name|external_system"],
      "tool_selection": [
        {{
          "tool_name": "exact name from catalog",
          "usage_mode": "required|optional|conditional",
          "reason": "why this business goal needs it",
          "condition": "required for conditional; null otherwise",
          "fallback": "required for optional/conditional; null only when required"
        }}
      ],
      "child_tools": ["exact selected tool names, derived from tool_selection"],
      "harness_tools": [
        {{
          "tool_name": "PascalCase deterministic tool name",
          "purpose": "small state, lifecycle, persistence, normalization, or deterministic calculation that should not consume model reasoning",
          "phase": "before_skill|after_skill",
          "trigger": "exact condition under which the Harness invokes it",
          "steps": ["2-5 deterministic implementation steps"],
          "input": {{"field": {{"type": "string|number|boolean|json", "required": true, "description": "string"}}}},
          "output": {{"field": {{"type": "string|number|boolean|json", "description": "string"}}}},
          "read_only": true
        }}
      ],
      "fresh_data_policy": "none|optional|required",
      "action_tool": {{
        "search_hint": "short concrete retrieval hint",
        "preserve_existing": true,
        "always_load": true,
        "read_only": false
      }},
      "operating_model": {{
        "role": "specific role the child model must perform",
        "hard_boundaries": ["imperative rule tied to this capability"],
        "workflow": [{{
          "step": 1,
          "name": "specific step name",
          "instructions": ["operation over named inputs, evidence, tools, calculations, or artifact fields"],
          "success_criteria": ["observable condition for completing this step"]
        }}],
        "decision_rules": ["domain-specific ordering, calculation, classification, freshness, or conflict rule"],
        "outcome_rules": {{
          "success": ["conditions"],
          "insufficient_input": ["conditions"],
          "error": ["conditions"]
        }},
        "artifact_contract": {{
          "mode": "none|write_file",
          "artifact_type": "string|null",
          "file_name_pattern": "string|null",
          "format": "json|markdown|null",
          "verification_steps": ["read-back or structural checks; empty only when mode is none"]
        }},
        "final_checks": ["specific assertion before ReturnSkillResult"]
      }},
      "complexity": {{"level": "bounded|split_required|too_simple", "estimated_steps": 4, "rationale": "string"}},
      "independence": {{"portable": true, "assumptions": ["string"]}},
      "evaluation_cases": [{{
        "id": "snake_case",
        "user_query": "realistic invocation",
        "available_context": {{"named input": "representative condition"}},
        "expected_outcome": "success|insufficient_input|error",
        "must_include": ["observable result property"],
        "must_not_include": ["boundary violation"]
      }}]
    }}
  ]
}}

Synthesize candidates only for tasks whose synthesis_decision is skilltool. The final task's input and output fields are authoritative: preserve every input name, type, source semantics and source_ref, and preserve every predicted output name, type and description. Map task sources deterministically as follows: user_input to user_input, ordinary_tool_output to ordinary_tool_output, upstream_artifact to upstream_artifact, and prior_output to prior_skill_output. Prefer already available upstream artifacts over recollecting or regenerating the same information. A required user_input is valid only with request_user acquisition; ordinary_tool_output must name either its upstream inventory asset or the selected ordinary tool. Inputs must be realistically obtainable. Outputs must be directly consumable. A task with required prior_output inputs is aggregate; a task with no required prior output is standalone. Do not invent SkillTool consumers: if an output is directly useful, name user_decision or external_system. Selecting no auxiliary tool is preferred when reasoning over supplied inputs is sufficient. Do not copy the entire catalog into child_tools.

Harness tools are optional, newly proposed deterministic helpers modeled after `ref/tools`. They are not model-callable `child_tools` and do not need to exist in AVAILABLE NON-SKILL PROJECT TOOLS. Add one only when a small before/after step is better implemented as code: resolving and ownership-checking an artifact reference, activating or updating stored state, performing a fixed calculation, normalizing a stable structure, or publishing a verified artifact. Do not turn reasoning, web research, ranking, writing, or an internal workflow paragraph into a Harness Tool. Keep `harness_tools` empty when no such deterministic boundary exists. A proposed Harness Tool must have a precise trigger, phase, typed contract, 2-5 deterministic steps, and no placeholder implementation.

The final task set is authoritative. Implement each task's declared inputs and predicted outputs; do not mine the profile or scenario for additional runtime requirements. An iteration-1 task may require an upstream_artifact only when that exact artifact is declared in the task and exists in input_inventory. It must never require the raw reference profile, raw scenario, or a prior SkillTool result. Convert its `user_input` fields into invocation-time inputs with a `request_user` acquisition path. Tools may fetch fresh external evidence internally when the task requires it, but they must not replace the declared task inputs.

The operating_model is mandatory and candidate-specific. Use 3-6 workflow steps, at least 3 hard boundaries, explicit outcome rules, and at least 4 final checks. Do not use vague steps such as merely 'analyze inputs', 'reason carefully', 'generate output', or 'ensure quality'. Name exact evidence fields, comparisons, classifications, thresholds, source checks, tool conditions, and artifact operations. If artifact_contract.mode is write_file, write and read back the artifact before returning success. Generate at least one success case, one insufficient-input case, and one boundary case per candidate.

Final cardinality check: `candidates` must contain exactly {len(requested_tasks)} object(s), covering exactly {_payload(requested_tasks)} and no other task IDs."""


def dedupe_merge_prompt(candidates: dict[str, Any], task_map: dict[str, Any]) -> str:
    compact_candidates = []
    for candidate in candidates.get("candidates") or []:
        compact_candidates.append({
            "skill_id": candidate.get("skill_id"),
            "skill_name": candidate.get("skill_name"),
            "business_goal": candidate.get("business_goal"),
            "task_ids": candidate.get("task_ids") or [],
            "invocation_mode": candidate.get("invocation_mode"),
            "required_inputs": [
                name for name, field in (candidate.get("input_schema") or {}).items()
                if (field or {}).get("required")
            ],
            "outputs": list((candidate.get("output_schema") or {}).keys()),
            "output_consumers": candidate.get("output_consumers") or [],
            "scope_includes": (candidate.get("scope") or {}).get("includes") or [],
            "scope_excludes": (candidate.get("scope") or {}).get("excludes") or [],
        })
    return f"""Review this SkillTool portfolio for semantic duplication and poor boundaries.

TASK MAP:
{_payload(task_map)}

CANDIDATE SUMMARIES (the full candidates are retained deterministically outside this review):
{_payload(compact_candidates)}

Return the complete revised portfolio:
{{
  "decisions": [
    {{
      "candidate_ids": ["skill_id"],
      "action": "keep|merge|split|drop",
      "reason": "string",
      "result_ids": ["skill_id"]
    }}
  ],
  "kept_candidate_ids": ["skill_id"],
  "portfolio_notes": ["string"]
}}

Keep candidates unless they are trivial, outside a skilltool task, or semantically duplicate another candidate in business goal, required evidence, and output consumer. Do not drop merely because candidates share a topic. Use only keep or drop actions; deterministic consolidation handles near-identical candidates after this review. Include every retained ID exactly once in kept_candidate_ids. Preserve user-intent coverage and keep aggregate capabilities a minority."""
