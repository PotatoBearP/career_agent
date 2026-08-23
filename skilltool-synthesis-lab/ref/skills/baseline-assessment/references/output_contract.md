# Output Contract

This document is a maintenance and evaluation reference. Runtime behavior is defined self-sufficiently in `SKILL.md`; the Skill must not read this file during an invocation.

## Success Result

A successful result contains:

Pass the result as a JSON object, not a JSON-encoded string, Markdown, or a code fence.

| Field | Meaning |
|---|---|
| `assessment_target` | Explicit or unambiguously inferred role, domain, or task target |
| `framework` | Whether the assessment dimensions were provided or conservatively model-derived |
| `overall` | Conservative synthesis across assessed key dimensions |
| `capabilities` | Evidence-backed level, confidence, evidence basis, and evidence references per dimension |
| `unknowns` | Up to six material dimensions that cannot be assessed from existing evidence |
| `conflicts` | Material contradictions and their effect on confidence |
| `limitations` | Boundaries on interpreting this result, without recommendations |

Use only these ability levels, in order:

```text
awareness → foundational → applied → independent → advanced
```

Use `low`, `medium`, or `high` confidence independently of level. Level answers “what capability is supported”; confidence answers “how securely is it supported.”

Evidence has two independent classifications:

- Source: `conversation`, `profile`, `tool_result`, `mcp_result`, `skill_result`, or `artifact`.
- Basis: `demonstrated`, `documented`, `self_reported`, or `inferred`.

Do not treat a Profile or artifact source as automatically strong. A résumé inside an artifact may still be user-authored and therefore both `documented` and `self_reported`.

## Insufficient-Input Result

Use `insufficient_input` when no target is identifiable or no existing evidence maps to the target. Return only:

- the target when identifiable;
- a short inventory of already available evidence;
- factual reasons the invocation cannot produce an assessment.

Do not convert those reasons into questions, evidence requests, or recommended actions.

## Prohibited Fields and Content

Do not add:

- `gaps` or deficit claims;
- numeric or weighted scores;
- questions or interview prompts;
- learning plans, recommendations, or next steps;
- suggested tools, searches, Profile reads, or next Skills.

## Overall-Level Rule

Order the five levels and choose the highest level supported by a strict majority of assessed key dimensions. Use the single dimension's level when only one dimension is assessable. Unknown dimensions do not count as zero, but sparse coverage lowers overall confidence.
