from __future__ import annotations

import json
from typing import Any


RELATION_SYSTEM_PROMPT = """You are an information-relation architect.
Return exactly one valid JSON object and no commentary.
An information object describes reusable information semantics, not an action, workflow step, UI component, concrete user value, or implementation detail.
The scenario defines scope. Profile facts are evidence only and must never silently redefine the domain.
Never invent user facts or current external facts.
Identifiers, labels, relations, contracts, traces, and bookkeeping fields supplied by this pipeline are control metadata only. Never treat them as user information, task inputs, task outputs, or business semantics.
Examples of forbidden information objects include task_id, p0_task_id, p1_task_id, relation_id, relation_contract, relation_signature, object_id, mention_id, sampling seed, k, labels, stage names, and provenance records.
Refer to those fields only where an explicitly requested response schema requires an exact control identifier."""


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def relation_extraction_prompt(task: dict[str, Any], scenario: str) -> str:
    return f"""STAGE: P0_RELATION_EXTRACTION

Decompose exactly one natural user task into its latent information relation:
t([I_0, ..., I_(m-1)], [O_0, ..., O_(n-1)]).

Definitions:
- An input information object is information that must be available before the task can be completed.
- An output information object is new information made available by completing the task.
- Do not expose internal operations such as extraction, clustering, scoring, formatting, prompting, validation, or tool calls as information objects.
- Fields contained in the supplied task payload for orchestration or traceability are not information dependencies. Never emit task IDs, relation/object/mention IDs, contracts, signatures, labels, stage data, provenance, or sampling parameters as an input or output object.
- Use the smallest sufficient input set and the smallest complete output set.
- Keep semantics reusable. Parameterize cities, employers, technologies, dates, counts, preferences, and other user-specific values.
- Every object needs a stable snake_case name, concrete description, JSON type, and plausible acquisition options.
- `acquisition_options` may contain only user_input, existing_artifact, ordinary_tool_output, or prior_skill_output.
- Return at least one input and one output.

SCENARIO:
{scenario}

BEGIN_TASK_JSON
{_json(task)}
END_TASK_JSON

Return:
{{
  "task_id": "exact input task_id",
  "inputs": [
    {{
      "name": "snake_case",
      "display_name": "natural-language label",
      "description": "stable information semantics",
      "type": "object|array|string|number|boolean",
      "acquisition_options": ["user_input|existing_artifact|ordinary_tool_output|prior_skill_output"]
    }}
  ],
  "outputs": [
    {{
      "name": "snake_case",
      "display_name": "natural-language label",
      "description": "stable information semantics",
      "type": "object|array|string|number|boolean"
    }}
  ],
  "relation_summary": "why these inputs are sufficient to produce these outputs"
}}"""


def object_clustering_prompt(mentions: list[dict[str, Any]], scenario: str) -> str:
    return f"""STAGE: OBJECT_CLUSTERING

Cluster information-object mentions into a role-agnostic canonical Object Set.
Input and output mentions may belong to the same canonical object when their reusable information semantics are genuinely identical.

Rules:
- Cluster by meaning, not merely similar wording.
- Mentions from the same P0 task, including two mentions on the same side of a relation, are not automatically distinct. Merge them when and only when they are genuinely interchangeable information semantics.
- Exact name or type equality is never sufficient evidence for merging; use descriptions, task provenance, and scenario meaning.
- Do not merge objects with different business meanings just because both are lists, reports, rankings, profiles, or plans.
- Do not merge incompatible JSON types.
- Preserve narrower and broader concepts separately unless they are interchangeable for task contracts.
- Every mention_id must appear exactly once.
- Canonical names use snake_case and must not contain sample-profile literals.
- Acquisition options are the union of member input mentions; output-only objects may keep an empty list.

SCENARIO:
{scenario}

BEGIN_OBJECT_MENTIONS_JSON
{_json(mentions)}
END_OBJECT_MENTIONS_JSON

Return:
{{
  "clusters": [
    {{
      "canonical_name": "snake_case",
      "display_name": "natural-language label",
      "description": "precise reusable semantics",
      "type": "object|array|string|number|boolean",
      "member_mention_ids": ["mention_id"],
      "merge_reason": "why every member is interchangeable"
    }}
  ]
}}"""


def p1_generation_prompt(
    relation: dict[str, Any],
    objects: list[dict[str, Any]],
    scenario: str,
    tool_catalog: dict[str, Any],
) -> str:
    object_by_id = {item["object_id"]: item for item in objects}
    selected = [object_by_id[item] for item in relation["input_object_ids"]]
    output = object_by_id[relation["output_object_id"]]
    return f"""STAGE: P1_TASK_GENERATION

Realize one sampled k-to-1 information relation as one natural, reusable user task.
The sampled relation is a hypothesis, not a command to force an invalid task. If it cannot form a plausible task, return `realizable: false` with reasons.

Hard contract:
- The task must require exactly the selected input objects and produce exactly the selected output object.
- Do not add another required information object, even when it would make the task easier.
- Do not remove or silently replace a selected object.
- The public task wording must not mention Object Set, clustering, k-to-1 relations, mappings, schemas, or pipeline stages.
- Relation JSON, object IDs, `relation_contract`, P0/P1 task IDs, signatures, labels, sampling evidence, provenance, and stage metadata are private design-time controls. They must never become a required input, output, input field name, user request, business goal, workflow variable, or instruction. Use them only to bind the response to the selected semantic objects.
- Runtime inputs must describe only real domain information that a user, an existing artifact, an ordinary tool, or a prior Skill can actually provide.
- The task must be something a normal user could request directly in one message.
- It must represent a meaningful decision or transformation, not retrieval, copying, formatting, or an internal analytical step.
- The scenario defines scope; never infer a domain from profile examples.
- Choose acquisition for every input from that object's acquisition_options. Prefer user_input or existing_artifact for standalone tasks.
- Ordinary tools may be proposed only from the supplied catalog, and only when essential.

SCENARIO:
{scenario}

BEGIN_RELATION_JSON
{_json(relation)}
END_RELATION_JSON

BEGIN_SELECTED_INPUT_OBJECTS_JSON
{_json(selected)}
END_SELECTED_INPUT_OBJECTS_JSON

BEGIN_SELECTED_OUTPUT_OBJECT_JSON
{_json(output)}
END_SELECTED_OUTPUT_OBJECT_JSON

AVAILABLE ORDINARY TOOLS:
{_json(tool_catalog)}

Return:
{{
  "realizable": true,
  "unrealizable_reasons": [],
  "task": {{
    "name": "natural user-facing service name",
    "business_goal": "concrete result from the user's perspective",
    "user_request_examples": ["2-4 realistic requests"],
    "invocation_mode": "standalone|aggregate",
    "input_bindings": [
      {{"object_id": "exact selected ID", "acquisition": "user_input|existing_artifact|ordinary_tool_output|prior_skill_output", "provider": "tool name or null", "fallback": "string or null"}}
    ],
    "output_object_id": "exact selected output ID",
    "synthesis_decision": "skilltool",
    "decision_reason": "why this is a bounded reusable Skill",
    "fresh_data_required": false
  }}
}}"""


def p1_validation_prompt(
    candidate: dict[str, Any],
    relation: dict[str, Any],
    objects: list[dict[str, Any]],
    scenario: str,
) -> str:
    object_ids = set(relation["input_object_ids"]) | {relation["output_object_id"]}
    selected = [item for item in objects if item.get("object_id") in object_ids]
    return f"""STAGE: P1_TASK_VALIDATION

Judge whether one generated P1 task is a valid realization of its sampled k-to-1 information relation.

Important scope:
- Do NOT compare this task with P0 tasks and do NOT reject it for duplicating a P0 task.
- Judge only relation fidelity, information sufficiency, output derivability, scenario fit, natural user expressibility, business value, and safety/boundaries.
- Treat all task/relation/object IDs, relation_contract data, signatures, labels, sampling data, provenance, and stage fields as private control metadata. Fail a candidate if any such metadata appears as runtime information, a public input/output field, task wording, or a user request.

Pass only when:
1. The declared inputs are sufficient to derive the declared output without hidden required information.
2. The output is genuinely new information rather than a renamed input.
3. A normal user could plausibly request the task directly.
4. The task stays inside the scenario and does not import profile-specific domain assumptions.
5. The task is non-trivial but bounded enough for one Skill.
6. Acquisition paths are plausible and do not require unavailable private data or unauthorized actions.
7. Every runtime input is real domain information; none is a pipeline identifier, relation contract, trace field, or other intermediate artifact metadata.

SCENARIO:
{scenario}

RELATION:
{_json(relation)}

OBJECT CONTRACTS:
{_json(selected)}

P1 TASK CANDIDATE:
{_json(candidate)}

Return:
{{
  "passed": true,
  "repairable": false,
  "rubrics": {{
    "relation_fidelity": "pass|fail",
    "input_sufficiency": "pass|fail",
    "output_derivability": "pass|fail",
    "scenario_alignment": "pass|fail",
    "natural_user_request": "pass|fail",
    "business_value": "pass|fail",
    "scope_and_safety": "pass|fail"
  }},
  "issues": [{{"code": "snake_case", "message": "specific reason"}}],
  "repair_instructions": ["specific change that preserves the exact relation"]
}}"""
