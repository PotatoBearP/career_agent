---
name: learning-progress-assessment
description: "Assess already-visible evidence against the current activated learning stage's existing objectives and completion criteria, producing a LearningProgressAssessment artifact and readiness signal. Use after the user has produced answers, code, reports, or other evidence. Do not collect evidence, search, redefine the rubric, teach, revise the plan, or update progress state."
model-entry: action-tool
allowed-tools:
  - Write
  - Read
  - Edit
  - ReturnSkillResult
---

# Learning Progress Assessment

Judge the user's current-stage outcomes against the frozen rubric and evidence supplied by the Harness.

## Evidence boundary

- Use only `<skill-action-input>` and evidence content already visible before this invocation in the forked conversation.
- Every input evidence item includes `visible_before_invocation`. An item marked false is unavailable; its summary is not a substitute for its content.
- Do not Read evidence files, Profile, memory, artifacts, or arbitrary paths. Do not use Web, MCP, GitHub, directory search, or another Skill.
- `Read` is allowed only to verify the assessment JSON written by this invocation.
- Write the assessment to a simple workspace-relative path such as `learning-progress-assessment.json`. Never use `/tmp`, an absolute path, Bash, or directory listing to choose or discover the output path.
- Create the file once with `Write`, then `Read` it back. If correction is required, use `Edit` only after that Read; do not overwrite it with another Write.
- Do not ask questions or collect/refresh evidence. Return `insufficient_input` when no relevant inspectable evidence supports meaningful assessment.

## Assessment rules

1. Use the supplied current stage and StagePackage objectives, expected evidence, and completion criteria without redefining them.
2. Map each visible evidence item to the objective(s) it genuinely supports. Existence of a repository/file or a self-report alone does not prove mastery.
3. For every objective, report `not_assessed`, `partial`, `met`, or `exceeded`, with calibrated confidence and evidence refs. Preserve conflicts and remaining gaps.
4. `advance` requires all required criteria and critical objectives to be supported by adequate evidence. Low coverage or material conflicts imply `uncertain`; unmet criteria normally imply `continue`; structural rubric/plan problems may imply `revise`.
5. Write and Read back one assessment JSON. Verify unique IDs and all evidence/objective references without shell commands, then call `ReturnSkillResult` exactly once. Never mutate LearningState.

## Artifact payload

```json
{
  "schema_version": "1.0",
  "artifact_type": "LearningProgressAssessment",
  "created_at": "ISO-8601",
  "assessment": {
    "plan_id": "string",
    "plan_ref": "artifact://UUID",
    "plan_version": 1,
    "stage_id": "string",
    "stage_package_ref": "artifact://UUID",
    "evidence": [{
      "id": "evidence-1",
      "source_type": "conversation | artifact | workspace_file | tool_result | mcp_result",
      "source_ref": "optional string",
      "summary": "string",
      "basis": "demonstrated | documented | self_reported | inferred"
    }],
    "objectives": [{
      "objective_ref": "objective-1",
      "status": "not_assessed | partial | met | exceeded",
      "confidence": "low | medium | high",
      "evidence_refs": ["evidence-1"],
      "assessment": "string",
      "remaining_gaps": ["string"]
    }],
    "overall": {
      "mastery": "insufficient | partial | meets | exceeds",
      "confidence": "low | medium | high",
      "coverage_summary": "string"
    },
    "readiness": "continue | advance | revise | uncertain",
    "readiness_rationale": "string",
    "limitations": ["string"]
  }
}
```

Use concise values in the user's language. On success, `result` contains only the temporary artifact descriptor, plan/stage identity, readiness, overall summary, top gaps, and limitations. The Harness publishes the opaque artifact reference. Missing evidence is `insufficient_input`, not `error`.
