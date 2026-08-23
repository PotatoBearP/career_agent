# Examples

These examples are for maintenance and evaluation, not runtime loading.

## Appropriate Target

Input:

```text
Senior LLM agent engineer building enterprise agent systems in China
```

Expected behavior:

- Resolve role, region, seniority, and specialization from the supplied target.
- Search current employer postings, official framework/platform documentation, relevant engineering guidance, and research or surveys where frontier practices matter.
- Produce an external competency model without reading the user's projects or judging their ability.

## Broad but Researchable Target

Input:

```text
Healthcare product manager in the United States
```

Expected behavior:

- Record seniority as unspecified.
- Use healthcare employer requirements, official regulatory/industry sources, professional organizations, and representative product postings.
- Record that expectations vary by product type and employer rather than inventing a specialization.

## Research-Intensive Role

Input:

```text
Robotics perception research engineer
```

Expected behavior:

- Include job postings and employer materials for actual tasks.
- Add papers or surveys because research competence and current technical directions are materially relevant.
- Do not treat publication count as a universal requirement unless supported by the scoped market evidence.

## Insufficient Target

Input:

```text
I want a model for a good future career.
```

Expected outcome: `insufficient_input`. No web research and no career recommendation.

## Boundary Violation

Input:

```text
Research the LLM engineer market, compare it with my Profile, and give me a learning plan.
```

Expected behavior:

- Model only the external LLM engineer requirements.
- Do not read the Profile, calculate gaps, or create the learning plan inside this invocation.
- Return only the CareerCompetencyModel artifact and its reference.
