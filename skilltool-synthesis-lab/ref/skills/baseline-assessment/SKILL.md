---
name: baseline-assessment
description: Assess the user's current capability baseline relative to an explicit or unambiguously inferred role, domain, or task target, using only evidence already present in the conversation, injected profile context, prior tool/MCP/skill results, or visible artifacts. Use when an evidence-based starting point is needed before career positioning, planning, or development decisions. Do not use this skill to collect evidence, interview or test the user, discover goals, identify gaps, or recommend next actions; return insufficient_input when the target or relevant evidence is absent.
model-entry: action-tool
---

# Baseline Assessment

Evaluate the evidence already available when this invocation begins. Act as an evidence judge, not an interviewer, investigator, planner, or router.

## Non-Negotiable Boundary

- Freeze the evidence boundary at invocation time.
- Use only information already visible in the current context: conversation content and invocation arguments, automatically injected Profile content, completed earlier tool/MCP/Skill results, and artifact or file contents already present in context.
- Do not call tools to acquire, inspect, refresh, verify, or expand evidence. Do not read Profile files, local files, this Skill's references, the web, MCP resources, or other Skills.
- Use `ReturnSkillResult` as the only tool call made by this invocation.
- Do not ask the user questions, administer a test, recommend actions, identify gaps, create a plan, or select a next Skill.
- Do not turn missing evidence into instructions for the main Agent. Report only what is insufficient for this invocation.

## Workflow

1. Identify the assessment target from explicit context or an unambiguous inference. The target must be a role, domain, or task capability—not a generic personality profile.
2. Inventory only target-relevant evidence already in context. Ignore generic biography that cannot support a capability judgment.
3. Use an assessment framework already provided in context. If none exists, construct a conservative target-relevant framework and mark it `model_derived`; do not claim that it is a current or authoritative market standard.
4. Separate evidence source from evidence basis, map each usable item to one or more capability dimensions, and preserve material contradictions.
5. Assign capability levels and confidence. Produce an overall level only from assessed capabilities; keep unsupported dimensions in `unknowns`.
6. Select the outcome and call `ReturnSkillResult` exactly once using the `skill_call_id` and `skill_name` from the Harness invocation envelope.

After `ReturnSkillResult` is accepted, treat this Skill invocation as complete. Do not add post-Skill guidance to its `summary` or `result`.

## Outcome Rules

Return `success` when both conditions hold:

- The target is explicit or unambiguously inferable.
- At least one existing evidence item supports a target-relevant capability assessment.

Partial assessment is valid. Record unsupported material dimensions as unknown rather than failing the entire assessment.

Return `insufficient_input` when either condition holds:

- The target cannot be identified without asking or investigating.
- No existing evidence maps to a target-relevant capability, even if generic background information exists.

Describe the insufficiency without phrasing it as a question, request, recommendation, or next action.

Return `error` only when an internal interpretation or serialization failure prevents a valid result. Missing or weak evidence is not an error.

## Evidence Model

Record source and basis independently.

Evidence sources:

- `conversation`: a statement or answer visible in the conversation.
- `profile`: content already injected from the user's Profile.
- `tool_result`: a completed non-MCP tool result already in context.
- `mcp_result`: a completed MCP result already in context.
- `skill_result`: a completed earlier Skill result already in context.
- `artifact`: an artifact or file content already visible in context.

Evidence bases:

- `demonstrated`: performance or output is directly observable in context.
- `documented`: a concrete record or artifact documents the fact.
- `self_reported`: the claim comes from the user or a user-maintained Profile.
- `inferred`: the judgment is derived rather than directly stated or demonstrated.

An item may have multiple bases. For example, a résumé claim may be both `documented` and `self_reported`; that does not make it independently verified.

Summarize evidence briefly and attach a coarse `source_ref` when available, such as a conversation turn, Profile section, tool name, or artifact path. Do not reproduce large excerpts, secrets, or hidden reasoning.

## Level and Confidence Rubric

Use exactly these ordered levels:

- `awareness`: recognizes basic concepts or terminology; no evidence of practical execution.
- `foundational`: understands fundamentals or completes bounded work with substantial guidance.
- `applied`: applies the capability in practical work, with some guidance or within familiar conditions.
- `independent`: completes target-relevant work independently and handles ordinary variation.
- `advanced`: handles complex or ambiguous work, improves systems or approaches, or guides others with demonstrated depth.

Use `low`, `medium`, or `high` confidence:

- `low`: evidence is sparse, conflicting, or entirely self-reported/inferred.
- `medium`: at least one concrete demonstrated or documented item supports the judgment, but breadth or corroboration is limited.
- `high`: repeated or corroborated demonstrated/documented evidence supports both level and breadth.

Never assign high confidence when all supporting evidence is `self_reported` or `inferred`. A self-report-only assessment may succeed, but its confidence must be low and it must not claim demonstrated ability.

For `overall.level`, choose the highest level supported by a strict majority of the assessed key dimensions. With one assessed dimension, use that dimension's level. Exclude unknown dimensions from the level calculation, but lower overall confidence when coverage is sparse. Do not omit weaker evidenced dimensions to inflate the overall level.

When evidence conflicts, record the conflict, lower the affected confidence, and continue assessing unaffected dimensions. Do not silently prefer the newest source or invent a resolution.

## Return Contract

Use English JSON keys and concise values in the user's language.
Pass `result` as a JSON object in the `ReturnSkillResult` arguments. Do not pass a JSON-encoded string, Markdown, or a code fence.

For `success`, pass this structure as `result`:

```json
{
  "assessment_target": {
    "name": "string",
    "basis": "explicit | inferred",
    "scope": "string"
  },
  "framework": {
    "source": "provided | model_derived",
    "summary": "string"
  },
  "overall": {
    "level": "awareness | foundational | applied | independent | advanced",
    "confidence": "low | medium | high",
    "summary": "string"
  },
  "capabilities": [
    {
      "dimension": "string",
      "level": "awareness | foundational | applied | independent | advanced",
      "confidence": "low | medium | high",
      "evidence_basis": ["demonstrated | documented | self_reported | inferred"],
      "evidence": [
        {
          "summary": "string",
          "source_type": "conversation | profile | tool_result | mcp_result | skill_result | artifact",
          "source_ref": "optional string"
        }
      ],
      "assessment": "string"
    }
  ],
  "unknowns": [
    {
      "dimension": "string",
      "reason": "string"
    }
  ],
  "conflicts": [
    {
      "dimension": "string",
      "summary": "string",
      "impact": "string"
    }
  ],
  "limitations": ["string"]
}
```

List at most six material unknowns; do not pad the array when fewer exist. Use empty arrays for no conflicts or limitations. Do not add `gaps`, scores, recommendations, next steps, questions, or handoffs.

For `insufficient_input`, pass this structure as `result`:

```json
{
  "assessment_target": {
    "name": "optional string",
    "basis": "explicit | inferred"
  },
  "available_evidence": [
    {
      "summary": "string",
      "source_type": "conversation | profile | tool_result | mcp_result | skill_result | artifact",
      "source_ref": "optional string"
    }
  ],
  "insufficiency_reasons": ["string"]
}
```

Omit `assessment_target` when no target is identifiable. Include only evidence already present, and do not describe how to obtain missing evidence.

For `error`, provide a concise non-sensitive diagnostic in `summary`; include a small JSON `result` only when it helps identify the failed interpretation or serialization stage.

## Final Check Before Returning

Verify all of the following:

- Every assessed level cites at least one existing evidence item.
- Source type and evidence basis are not conflated.
- Self-report-only judgments are low confidence.
- Unknowns are not described as gaps.
- No claim depends on newly gathered information.
- No question, recommendation, action item, or next-Skill instruction appears in `summary` or `result`.
- `skill_call_id` and `skill_name` exactly match the current Harness envelope.
