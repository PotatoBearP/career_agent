# CareerCompetencyModel Output Contract

This is a maintenance and evaluation reference. Runtime rules are self-contained in `SKILL.md`; the Skill must not read this file during an invocation.

## Artifact Identity

- `artifact_type`: exactly `CareerCompetencyModel`
- `schema_version`: `1.0`
- format: standalone JSON
- canonical content: the saved file, not the abbreviated `ReturnSkillResult.result`

## Required Sections

| Section | Purpose |
|---|---|
| `target` | Role and known industry, region, seniority, specialization, plus scope notes |
| `methodology` | Research date, concise method, and source-family mix |
| `requirements` | Atomic external requirements with categories and source references |
| `job_tasks` | Recurring role responsibilities supported by sources |
| `competency_domains` | Grouped competencies, importance, expected depth, and task/evidence links |
| `relationships` | Optional prerequisite or part-of relationships; an empty array is valid |
| `sources` | Full provenance records with URLs and access dates |
| `limitations` | Scope, recency, availability, representativeness, and evidence limitations |

## Controlled Values

Requirement categories:

```text
knowledge | skill | tool | job_task | experience | credential
```

Importance:

```text
core | important | supporting
```

Expected depth:

```text
awareness | working | independent | advanced
```

Expected depth describes the external role expectation. It is not an assessment of the user.

## Provenance Rules

- Every requirement, task, and competency must resolve to at least one source ID.
- Core competencies should normally have evidence from two independent sources.
- Sources must include title, URL, publisher, source type, access date, and relevance.
- Paraphrase source requirements. Do not store long copied passages.
- Search snippets alone are weak support and should not determine a core competency when the page is fetchable.

## Return Result

The successful lifecycle result contains only an artifact reference and compact statistics:

```json
{
  "artifact": {
    "type": "CareerCompetencyModel",
    "path": "career_competency_model_role_YYYY-MM-DD.json",
    "format": "json",
    "schema_version": "1.0"
  },
  "target": {},
  "counts": {
    "domains": 0,
    "competencies": 0,
    "requirements": 0,
    "job_tasks": 0,
    "sources": 0
  },
  "limitations": []
}
```

Do not duplicate the full artifact in the Tool result.

## Prohibited Content

Do not include user capabilities, personal evidence, gaps, fit judgments, scores, study order, courses, learning plans, or career recommendations.
