---
name: learning-plan
description: "Compare an existing CareerCompetencyModel artifact with an existing BaselineAssessment artifact and produce a staged LearningPlan artifact: identify and prioritize the gaps between the target career expectations and the user's current assessed baseline, and organize them into a stage-based learning path. Use when the user needs a concrete, prioritized sequence of capabilities to develop toward a career target, grounded in artifacts already produced upstream. Do not use for researching a career, redoing a baseline assessment, course recommendations, daily study schedules, or teaching execution; return insufficient_input when the required upstream artifacts are missing, mismatched, or unusably stale."
model-entry: action-tool
allowed-tools:
  - Read
  - Write
  - ReturnSkillResult
---

# Learning Plan

Bridge the current state to the target state: consume a `CareerCompetencyModel` artifact (what the target career requires) and a `BaselineAssessment` artifact (where the user is today), compute the gaps, prioritize them, and organize them into a stage-based learning path.

## Hard Boundary

- This Skill does not rebuild the competency model and does not redo the baseline assessment. It only consumes their artifacts.
- Use only `Read`, `Write`, and `ReturnSkillResult`. Do not use Web tools, MCP, other Skills, or shell commands.
- The Harness resolves opaque upstream refs and injects `model` and `baseline` snapshots. Use `Read` only to read back the artifact written by this invocation. Do not browse or discover other local files, and do not read the user's Profile, résumé, portfolio, memories, or personal files.
- Do not ask the user questions. Constraint and goal collection happens in the main conversation before this invocation; this Skill only consumes user-stated inputs.
- All constraints and goals must come from the user's explicit statements passed through `<skill-action-input>`. Never invent the user's weekly time, deadline, goals, or personal circumstances.
- Do not include course recommendations, resource lists, daily schedules, or micro-task breakdowns.
- Keep the first version practical: a small set of prioritized gaps and a small number of stages.

## Workflow

### 1. Load & Validate

Read the invocation inputs from `<skill-action-input>`:

- `model_ref`: opaque reference of a `CareerCompetencyModel` artifact.
- `baseline_ref`: opaque reference of a `BaselineAssessment` artifact.
- `model` and `baseline`: canonical snapshots already resolved and ownership-checked by the Harness.
- `goal_level`: optional user goal on the depth ladder (`working`, `independent`, or `advanced`). Absent means market-aligned.
- `constraints`: user-stated planning constraints. `available_time_per_week` and `deadline` are required fields; `deadline` is `null` only when the user explicitly said they have no deadline. Remaining fields (`resource_constraints`, `explicit_goals`, `notes`) may be absent.

If either snapshot is absent, return `insufficient_input`; do not attempt filesystem discovery. Validate the injected snapshots:

- **Target correspondence**: the model's `target.role` and the baseline's `assessment_target.name` must semantically refer to the same career target. Exact string equality is not required, but materially different targets invalidate the pair.
- **Freshness**: judge whether the artifacts are usable for this plan. Consider the model's `methodology.as_of` and the baseline's completion timestamp, plus any context signals that the user's situation has materially changed (new job, changed target, invalidated evidence). There is no fixed age threshold — record the judgment.

Record the judgment in `lineage.validation`. If either artifact is missing, unreadable, mismatched, or judged unusably stale, return `insufficient_input` describing what is missing without phrasing it as a question, request, recommendation, or next action.

**Success criterion:** One usable model and one usable baseline are in hand, and the validation judgment is recorded.

### 2. Identify Gaps

Compute the target depth for each competency:

- `target_depth` = `goal_level` when the user provided one (applies globally), otherwise the model's `expected_depth`.

Map levels to a shared rank using exactly this table:

| Model `expected_depth` | Rank | Baseline `level` | Rank |
| --- | --- | --- | --- |
| awareness | 0 | awareness | 0 |
| working | 2 | foundational | 1 |
| independent | 3 | applied | 2 |
| advanced | 4 | independent | 3 |
| — | — | advanced | 4 |

`working` corresponds to `applied` (rank 2). `foundational` is one rank below `working`.

For each model competency, find its current level by semantically matching baseline capability dimensions to the competency (same or equivalent name/scope). Then compute `delta = rank(target_depth) − rank(current_level)`:

- **met**: `delta ≤ 0`. Exclude from `prioritized_gaps`; the plan only contains what needs work.
- **shallow**: `1 ≤ delta ≤ 2`. The user has a base but insufficient depth.
- **missing**: no baseline evidence for the competency (unknown/absent), or `delta ≥ 3`. Rationale must note when only awareness-level evidence exists but the depth gap is fundamental.

Keep `expected_depth` in every gap entry even when `target_depth` differs, so the market anchor is preserved.

When baseline dimensions cannot be mapped to any model competency, record that in `limitations`; do not silently drop or invent a mapping.

**Success criterion:** Every gap entry has a defensible delta, category, and current/target level.

### 3. Prioritize

Order the gaps deterministically:

1. Primary key `importance`: `core` before `important` before `supporting`.
2. Secondary key: `delta` descending (treat missing-with-no-evidence as `delta = 4`).
3. Within the same band, honor the model's `prerequisite` relationships as ordering constraints: a prerequisite gap ranks before the gap that depends on it.
4. A user deadline or tight weekly time may lift constrained gaps; record such adjustments in the gap's `rationale`.

Assign `priority` as the final 1-based position. Do not relabel importance or re-research the occupation.

**Success criterion:** The order is explainable from importance, delta, prerequisites, and user constraints.

### 4. Build Learning Path

Organize the prioritized gaps into stages using this default skeleton, merging or skipping stages when the gap set is small:

- **Foundation**: gaps categorized `missing`, or with `delta ≥ 2`, plus the roots of prerequisite chains.
- **Core**: `core`/`important` gaps with `1 ≤ delta ≤ 2`.
- **Applied**: remaining `shallow` gaps, framed around project-based consolidation.
- **Job-ready**: gaps whose `target_depth` is `independent` or `advanced` with `delta = 1`.

Drop any stage with no gaps. For each retained stage include:

- `id`, `name`, `goal`: the stage's headline objective;
- `competency_refs`: the gap competencies assigned to this stage;
- `expected_level_after`: the target depth (model ladder: `awareness | working | independent | advanced`) the assigned competencies should reach by stage end;
- `estimated_duration`: when the user provided weekly time and/or a deadline, derive the duration from those constraints; otherwise give a coarse range and mark the basis as estimate;
- `depends_on`: stage ordering dependencies;
- `rationale`.

Do not produce daily or weekly micro-schedules, and do not recommend specific courses or resources.

**Success criterion:** Stages are coherent, ordered, and each contains at least one gap with a stated goal and expected level.

### 5. Write & Return

Use `Write` to save one standalone JSON artifact in the current workspace. Name it:

```text
learning_plan_<role-slug>_<YYYY-MM-DD>.json
```

The JSON must use this top-level structure:

```json
{
  "schema_version": "1.0",
  "artifact_type": "LearningPlan",
  "created_at": "ISO-8601 timestamp",
  "version": 1,
  "updated_at": "same ISO-8601 timestamp as created_at",
  "planning_constraints": {
    "available_time_per_week": "verbatim user-stated value",
    "deadline": "verbatim user-stated value or null",
    "resource_constraints": "optional verbatim user-stated value",
    "explicit_goals": "optional verbatim user-stated value",
    "notes": "optional verbatim user-stated value"
  },
  "lineage": {
    "model_ref": "artifact://UUID or null",
    "model_as_of": "YYYY-MM-DD or null",
    "baseline_ref": "artifact://UUID or null",
    "baseline_completed_at": "ISO-8601 or null",
    "validation": {
      "target_correspondence": "string",
      "freshness_judgment": "string",
      "notes": ["string"]
    }
  },
  "target": {
    "role": "string",
    "industry": "string or null",
    "region": "string or null",
    "seniority": "string or null",
    "specialization": "string or null"
  },
  "goal_level": "working | independent | advanced | null",
  "baseline_summary": {
    "overall_level": "awareness | foundational | applied | independent | advanced",
    "overall_confidence": "low | medium | high",
    "coverage_note": "string"
  },
  "prioritized_gaps": [
    {
      "competency_ref": "competency-1",
      "competency_name": "string",
      "domain_ref": "domain-1",
      "importance": "core | important | supporting",
      "expected_depth": "awareness | working | independent | advanced",
      "target_depth": "awareness | working | independent | advanced",
      "current_level": "awareness | foundational | applied | independent | advanced | null",
      "gap": "missing | shallow",
      "delta": 1,
      "priority": 1,
      "prerequisites": ["competency-2"],
      "rationale": "string"
    }
  ],
  "stages": [
    {
      "id": "stage-1",
      "name": "Foundation",
      "goal": "string",
      "competency_refs": ["competency-1"],
      "expected_level_after": "awareness | working | independent | advanced",
      "estimated_duration": {
        "value": "string",
        "basis": "from_user_constraints | estimate"
      },
      "depends_on": ["stage-id or empty"],
      "rationale": "string"
    }
  ],
  "assumptions": ["string"],
  "limitations": ["string"]
}
```

Use English JSON keys and concise values in the user's language. Validate that every `competency_ref`, `domain_ref`, and prerequisite reference resolves before writing. Do not embed the user's profile or personal data in the artifact.

After `Write` succeeds, use `Read` on that exact artifact path. Verify the persisted file—not only the in-memory draft—before returning success:

- it is complete, valid JSON;
- all required top-level sections exist;
- every internal reference resolves;
- every gap entry has a valid delta, category, and levels;
- no constraints or goals were invented;
- no user Profile or personal data was written.

If verification finds a correctable serialization or completeness problem, rewrite the same artifact and read it back once more. Return `error` if the persisted artifact still cannot be validated. Do not use this verification step to inspect any other workspace file.

After the file is successfully written and read back, call `ReturnSkillResult` exactly once with the current Harness `skill_call_id`, `skill_name`, and:

- `outcome: "success"`;
- a concise summary of the plan;
- `result.artifact` containing `type`, `path`, `format`, and `schema_version`;
- `result.target`;
- `result.counts` for gaps and stages;
- `result.limitations`.

Do not place the full plan in the Tool result; the artifact is the canonical plan. After `ReturnSkillResult` is accepted, the Skill invocation is complete.

Return `insufficient_input` only when a usable model or baseline cannot be established from the refs and context. Return `error` for read/write failures or invalid artifact serialization. Never report success before the artifact exists.

**Success criterion:** One valid `LearningPlan` JSON artifact exists and its reference is returned through the lifecycle tool.

## Final Check Before Returning

Verify all of the following:

- Every gap cites a model competency and carries a defensible `delta`, category, and levels.
- `expected_depth` is preserved in every gap entry.
- No gap exists for a `met` competency.
- Stage ordering follows importance, delta, prerequisites, and user constraints.
- Every constraint and goal in the artifact traces to user statements; absent ones appear only in `assumptions`.
- `lineage.validation` records the target-correspondence and freshness judgment.
- `skill_call_id` and `skill_name` exactly match the current Harness envelope.
