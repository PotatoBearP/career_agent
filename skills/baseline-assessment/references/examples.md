# Examples

These are maintenance and evaluation examples. The Skill must not read this file during an invocation.

## Demonstrated-Evidence Success

Existing context:

- Target: backend engineering.
- A prior tool result shows the user implemented and tested a REST endpoint without assistance.
- An artifact already visible in context contains the implementation and tests.

Expected behavior:

- Return `success`.
- Assess the evidenced implementation dimension using `demonstrated` with `tool_result` and/or `artifact` sources.
- Keep unsupported backend dimensions in `unknowns`.
- Do not inspect additional files or recommend what to learn next.

## Self-Report-Only Success

Existing context:

- Target: product management.
- The user says they independently wrote requirements and coordinated two releases.
- No work product or corroborating result is present.

Expected behavior:

- Return `success` because a target and relevant evidence exist.
- Mark the evidence `self_reported` with source `conversation`.
- Use low confidence and avoid claiming demonstrated ability.

## Injected-Profile Success

Existing context:

- Target: data analysis.
- The Harness has already injected a Profile section stating that the user regularly uses SQL for monthly reporting.

Expected behavior:

- Treat the visible Profile content as eligible pre-existing evidence.
- Mark it `self_reported` unless the context itself provides stronger support.
- Do not read the Profile store or refresh the Profile.

## Partial Success

Existing context:

- Target: frontend engineering.
- A prior artifact demonstrates component implementation, but no evidence covers testing, accessibility, or performance.

Expected behavior:

- Return `success` for the supported capability.
- Put only the most material unsupported dimensions in `unknowns`.
- Do not relabel unknowns as gaps.

## Conflicting Evidence

Existing context:

- The Profile says the user works independently with Python.
- A prior exercise result shows they needed substantial guidance on a basic Python task.

Expected behavior:

- Preserve both items and report a conflict.
- Lower confidence for the affected dimension.
- Continue assessing unaffected dimensions when evidence permits.

## Insufficient Target

Existing context:

- The user says, “Assess my baseline,” but no role, domain, task, or unambiguous earlier goal is visible.

Expected behavior:

- Return `insufficient_input`.
- State that no assessment target is identifiable.
- Do not ask what target the user has.

## Insufficient Evidence

Existing context:

- Target: machine-learning engineering.
- The only other fact is the user's city.

Expected behavior:

- Return `insufficient_input` because the background fact does not support a target-relevant capability judgment.
- Do not search, inspect Profile, request a résumé, or propose a test.

## Boundary Violation

Bad behavior:

> I need more information, so I will read your Profile, search your files, and then ask three questions. After that, I recommend calling the learning-plan Skill.

Why it fails:

- It collects information after invocation.
- It asks questions.
- It directs the Agent's next actions and routes to another Skill.
