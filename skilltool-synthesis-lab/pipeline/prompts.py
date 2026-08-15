from __future__ import annotations

import json
from typing import Any


SYSTEM_PROMPT = """You are a SkillTool portfolio architect. Design reusable, standalone AI capabilities from three independent inputs: user profile facts, current state, and a business scenario. A SkillTool is a bounded business capability executed by a child model through an external API. It must not depend on an application implementation.

Rules:
1. Return strict JSON only. Never wrap JSON in Markdown.
2. Preserve uncertainty and evidence provenance. Do not invent personal facts or live market facts.
3. Prefer a portfolio of composable capabilities over a single giant workflow.
4. Every required input must be available from profile, state, scenario, explicit user input, an external data connector, or a named prior SkillTool output.
5. Every output must have an explicit schema and at least one named consumer.
6. A SkillTool owns one meaningful business decision or transformation. Reject trivial formatting/retrieval wrappers and split multi-decision mega-skills.
7. SkillTools are portable: no main-program imports, database assumptions, UI state, route names, or internal service calls.
8. Profile and scenario are strictly decoupled. The scenario defines the problem space. The profile only supplies personal evidence and constraints inside that space. Never infer a target industry, role, or scenario domain from education, major, projects, or skills.
9. If the scenario domain is open, keep exploration cross-domain or request an explicit domain; never silently default to the profile's background.
10. Auxiliary tools may only come from the supplied non-Skill tool catalog. Select none by default. Every selected tool needs a required, optional, or conditional usage mode and a concrete reason. Conditional tools need a condition; optional tools need a fallback.
11. Never select Skill, discover_skills, ReturnSkillResult, a generated SkillActionTool, or another recursive Skill entry as an auxiliary tool.
12. Use snake_case IDs and PascalCase tool names."""


def _payload(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def demand_analysis_prompt(profile: dict[str, Any], state: dict[str, Any], scenario: dict[str, Any]) -> str:
    return f"""Analyze the user's needs for this scenario.

PROFILE:
{_payload(profile)}

CURRENT STATE:
{_payload(state)}

SCENARIO:
{_payload(scenario)}

Return this JSON object:
{{
  "scenario_interpretation": {{
    "scenario_goal": "string",
    "domain_mode": "open|explicit",
    "explicit_domains": ["string"],
    "profile_facts_used_as_evidence": ["string"],
    "forbidden_profile_to_scenario_inferences": ["string"]
  }},
  "decision_context": {{
    "stage": "string",
    "primary_decision": "string",
    "constraints": ["string"],
    "known_evidence": ["string"],
    "missing_evidence": ["string"],
    "success_definition": ["string"]
  }},
  "needs": [
    {{
      "need_id": "need_snake_case",
      "business_need": "string",
      "why_now": "string",
      "decision_enabled": "string",
      "evidence_required": ["string"],
      "priority": "must|should|could"
    }}
  ]
}}
Cover the scenario comprehensively without turning missing market evidence into facts."""


def task_synthesis_prompt(
    profile: dict[str, Any],
    state: dict[str, Any],
    scenario: dict[str, Any],
    demand_analysis: dict[str, Any],
) -> str:
    return f"""Convert the analyzed needs into a complete but modular task and scene map.

PROFILE SUMMARY:
{_payload(profile)}

STATE:
{_payload(state)}

SCENARIO:
{_payload(scenario)}

NEED ANALYSIS:
{_payload(demand_analysis)}

Return:
{{
  "tasks": [
    {{
      "task_id": "task_snake_case",
      "name": "string",
      "scene": "string",
      "business_goal": "one meaningful outcome",
      "need_ids": ["need_id"],
      "inputs": [
        {{"name": "string", "source": "profile|state|scenario|user_input|external_data|prior_output", "available": true, "from_task": null}}
      ],
      "outputs": [
        {{"name": "string", "consumer_tasks": ["task_id"], "final_consumer": "user|decision|another system|null"}}
      ],
      "dependencies": ["task_id"],
      "estimated_steps": 3,
      "fresh_data_required": false
    }}
  ],
  "coverage": [
    {{"required_output": "string", "covered_by": ["task_id"]}}
  ]
}}

Use 6-12 tasks. Cover only the supplied scenario. For an open-domain career exploration scenario, include career stage recognition, cross-domain hypothesis formation, industry/problem exploration, role-family positioning, organization/opportunity discovery, comparison/prioritization, and validation design. Separate live-data collection from reasoning over collected evidence. A technical profile must not turn a generic scenario into a technology-specific scenario."""


def candidate_synthesis_prompt(
    profile: dict[str, Any],
    state: dict[str, Any],
    scenario: dict[str, Any],
    demand_analysis: dict[str, Any],
    task_map: dict[str, Any],
    tool_catalog: dict[str, Any],
    skilltool_template: dict[str, Any],
) -> str:
    return f"""Synthesize reusable SkillTool candidates for the task map.

PROFILE:
{_payload(profile)}

STATE:
{_payload(state)}

SCENARIO:
{_payload(scenario)}

NEEDS:
{_payload(demand_analysis)}

TASK MAP:
{_payload(task_map)}

SKILLTOOL TEMPLATE (every candidate must follow this structure):
{_payload(skilltool_template)}

AVAILABLE NON-SKILL PROJECT TOOLS:
{_payload(tool_catalog)}

Return:
{{
  "candidates": [
    {{
      "skill_id": "snake_case",
      "skill_name": "kebab-case",
      "tool_name": "PascalCase",
      "title": "string",
      "business_goal": "one non-trivial outcome",
      "when_to_use": "string",
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
          "source": "profile|state|scenario|user_input|external_data|prior_skill_output",
          "available": true
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
      "fresh_data_policy": "none|optional|required",
      "complexity": {{"level": "bounded|split_required|too_simple", "estimated_steps": 4, "rationale": "string"}},
      "independence": {{"portable": true, "assumptions": ["string"]}},
      "evaluation_cases": [
        {{"case": "string", "expected_outcome": "success|insufficient_input|error"}}
      ]
    }}
  ]
}}

Inputs must be realistically obtainable. Outputs must be directly consumable. A candidate that both discovers live opportunities and makes a personal decision should normally be split. Selecting no auxiliary tool is preferred when reasoning over supplied inputs is sufficient. Do not copy the entire catalog into child_tools."""


def dedupe_merge_prompt(candidates: dict[str, Any], task_map: dict[str, Any]) -> str:
    return f"""Review this SkillTool portfolio for semantic duplication and poor boundaries.

TASK MAP:
{_payload(task_map)}

CANDIDATES:
{_payload(candidates)}

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
  "final_candidates": [same complete candidate schema as input],
  "portfolio_notes": ["string"]
}}

Merge only when business goal, required evidence, and output consumers substantially overlap. Do not merge merely because candidates share a topic. Drop trivial tools. Split candidates with multiple independent business decisions. Preserve task coverage."""
