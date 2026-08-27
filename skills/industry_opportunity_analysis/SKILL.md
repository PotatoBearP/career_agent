---
name: industry_opportunity_analysis
description: This skill should be used when the user wants to analyze an industry or role area's current trends, opportunities, risks, suitable candidate profiles, and entry suggestions. It produces a trend summary, opportunities, risks, recommended roles, and entry suggestions using market evidence. It should not be used for personal target-role selection unless user profile and candidate roles are ready.
---

# Industry Opportunity Analysis

## Purpose

Analyze market or industry opportunity so the user can decide whether and how to explore an industry or role area.

## When to Use This Skill

- The user asks about industry trends or market opportunities.
- The user wants risks and entry suggestions for an industry or role area.
- A previous skill needs current market context before positioning.

## When Not to Use This Skill

- Use `target_role_positioning` when the user needs a primary target role.
- Use `career_risk_assessment` when the user asks mainly about personal career risk.
- Use `application_strategy_planning` when the user is ready to apply.

## Required Inputs

- Required: `market_trend_resource`.
- Optional: `user_profile_resource`, `target_industry`.
- Derived from conversation: geography, seniority, target roles, time horizon.
- Must be fetched or requested: current reports, job market evidence, role demand signals, and official sources.

## Missing Context Policy

Ask at most 3 questions if target industry, geography, or decision purpose is unclear. If the user wants a first-pass answer, proceed with explicit assumptions and avoid unsupported current-market claims.

## Workflow

1. Confirm industry, role area, geography, and time horizon.
2. Gather or use current market evidence.
3. Summarize major trends and uncertainty.
4. Identify opportunity areas and explain why they matter.
5. Identify risks, hype, saturation, regulation, or execution barriers.
6. Recommend suitable roles and candidate profiles.
7. Provide entry suggestions and low-cost validation actions.
8. Produce a state update for possible handoff.

## Tool Use Policy

- `WebSearchTool`: Use for current market trends, role demand, hiring signals, and industry changes.
- `WebFetchTool`: Use for specific reports, official pages, job descriptions, or cited articles.
- Do not use tools that are not listed in the metadata.
- If a required tool is unavailable, state the limitation and proceed with assumptions only when safe.

## Output Contract

Return `trend_summary`, `opportunities`, `risks`, `recommended_roles`, and `entry_suggestions`.

See `references/output_contract.md` for the full output schema.

## Verification Checklist

Check evidence support and shortcut risk.

See `references/verifier.md` for the full verification rubric.

## Handoff Policy

This skill may hand off to target role positioning, career risk assessment, or application strategy planning.

See `references/handoff_policy.md` for detailed handoff conditions.

## Failure Modes

- Producing generic industry commentary.
- Relying on hype without evidence.
- Ignoring geography, seniority, or time horizon.
- Recommending entry paths that are too simplistic.
- Omitting risks and uncertainty.

## Final Response Requirements

The response must include all required fields, state assumptions, cite or describe evidence when used, warn about uncertainty, and recommend the next skill or action when appropriate.
