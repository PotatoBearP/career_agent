# Verifier Rubric

Use this rubric to evaluate generated `ReturnSkillResult` arguments for `baseline-assessment`.

## Checks

### Evidence Traceability

Pass when every assessed capability includes at least one concise evidence item with a valid source type, and the item existed before invocation.

Fail when an assessment relies on newly gathered information, generic biography, invented evidence, or an unsupported level.

### Source and Basis Separation

Pass when the location of evidence and its evidentiary nature are classified independently.

Fail when Profile, tool, MCP, or artifact content is assumed to be demonstrated or verified solely because of its source.

### Confidence Calibration

Pass when self-report-only or inference-only judgments are low confidence, conflicts lower confidence, and high confidence requires repeated or corroborated concrete evidence.

Fail when a confident judgment rests only on user claims, a job title, course attendance, or unsupported inference.

### Outcome Selection

Pass when `success` requires an identifiable target plus at least one relevant evidence item, `insufficient_input` covers missing target/evidence, and `error` is reserved for internal execution failure.

Fail when partial evidence is rejected despite supporting a valid partial assessment, or missing evidence is labeled as an error.

### Boundary Compliance

Pass when the Skill uses no information-gathering tool, asks no questions, and returns no gaps, recommendations, next steps, or Skill routing.

Fail when it reads Profile/files/references, calls Web/MCP/another Skill, administers a test, or tells the main Agent what to do after return.

### Contract Integrity

Pass when the success or insufficient-input JSON shape is respected, unknowns are limited to material items, conflicts are explicit, and the call ID/name match the Harness envelope.

## Verdict

Return one of:

- `PASS`
- `PASS_WITH_MINOR_ISSUES`
- `FAIL`

Use this evaluation shape:

```json
{
  "verdict": "PASS | PASS_WITH_MINOR_ISSUES | FAIL",
  "failed_checks": [],
  "notes": "",
  "suggested_revision": ""
}
```
