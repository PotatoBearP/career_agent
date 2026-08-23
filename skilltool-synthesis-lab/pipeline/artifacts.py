from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", value.lower().replace("_", "-")).strip("-")
    if not slug:
        raise ValueError("Skill candidate has no safe skill_name")
    return slug[:64]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _bullets(values: list[Any], *, empty: str = "- None.") -> str:
    items = [str(value).strip() for value in values if str(value).strip()]
    return "\n".join(f"- {item}" for item in items) if items else empty


def _render_inputs(inputs: dict[str, Any]) -> str:
    lines: list[str] = []
    for name, raw_field in inputs.items():
        field = raw_field or {}
        requirement = "required" if field.get("required") else "optional"
        source = str(field.get("source") or "unspecified")
        source_ref = field.get("source_ref")
        acquisition = field.get("acquisition") or {}
        supply = f"source `{source}`"
        if source_ref:
            supply += f", asset `{source_ref}`"
        if acquisition.get("mode"):
            supply += f", acquisition `{acquisition['mode']}`"
        lines.append(
            f"- `{name}` ({field.get('type') or 'object'}, {requirement}; {supply}): "
            f"{field.get('description') or name}"
        )
        if acquisition.get("fallback"):
            lines.append(f"  Fallback: {acquisition['fallback']}")
    return "\n".join(lines) if lines else "- No invocation fields; use only context already present at invocation time."


def _render_workflow(workflow: list[Any]) -> str:
    sections: list[str] = []
    for index, raw_step in enumerate(workflow, start=1):
        step = raw_step or {}
        number = step.get("step") or index
        name = str(step.get("name") or f"Step {number}").strip()
        instructions = _bullets(step.get("instructions") or [])
        criteria = _bullets(step.get("success_criteria") or [])
        sections.append(
            f"### {number}. {name}\n\n{instructions}\n\n"
            f"Success criteria:\n\n{criteria}"
        )
    return "\n\n".join(sections)


def _render_outcomes(outcome_rules: dict[str, Any]) -> str:
    labels = (("success", "Success"), ("insufficient_input", "Insufficient input"), ("error", "Error"))
    return "\n\n".join(
        f"### {label}\n\n{_bullets(outcome_rules.get(key) or [])}"
        for key, label in labels
    )


def _write_value(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = value if isinstance(value, str) else _json(value) + "\n"
    path.write_text(serialized, encoding="utf-8")


def persist_stage_artifacts(run_dir: Path, payload: dict[str, Any]) -> None:
    manifest: list[dict[str, Any]] = []
    intermediate_dir = run_dir / "intermediate-results"
    for index, trace in enumerate(payload.get("synthesis_trace") or [], start=1):
        stage = str(trace.get("stage") or f"stage-{index}")
        stage_slug = _safe_slug(stage)
        relative_dir = Path("stages") / f"{index:02d}-{stage_slug}"
        stage_dir = run_dir / relative_dir
        stage_dir.mkdir(parents=True, exist_ok=True)
        metadata = {
            "stage": stage,
            "status": trace.get("status"),
            "duration_ms": trace.get("duration_ms"),
            "operation": trace.get("operation"),
        }
        _write_value(stage_dir / "stage.json", metadata)
        stage_input = trace.get("input") or {}
        _write_value(stage_dir / "input.json", stage_input)
        if stage_input.get("system_prompt") is not None:
            _write_value(stage_dir / "system-prompt.txt", str(stage_input["system_prompt"]))
        if stage_input.get("user_prompt") is not None:
            _write_value(stage_dir / "user-prompt.txt", str(stage_input["user_prompt"]))
        model_exchange = trace.get("model_exchange") or {}
        if model_exchange:
            _write_value(stage_dir / "model-exchange.json", model_exchange)
            if model_exchange.get("request") is not None:
                _write_value(stage_dir / "model-request.json", model_exchange["request"])
            if model_exchange.get("raw_response") is not None:
                _write_value(stage_dir / "raw-response.txt", str(model_exchange["raw_response"]))
            if model_exchange.get("response_content") is not None:
                _write_value(stage_dir / "response-content.txt", str(model_exchange["response_content"]))
        for iteration_index, iteration_trace in enumerate(trace.get("model_iterations") or [], start=1):
            iteration_dir = stage_dir / "iterations" / f"{iteration_index:02d}"
            iteration_input = iteration_trace.get("input") or {}
            _write_value(iteration_dir / "input.json", iteration_input)
            if iteration_input.get("system_prompt") is not None:
                _write_value(iteration_dir / "system-prompt.txt", str(iteration_input["system_prompt"]))
            if iteration_input.get("user_prompt") is not None:
                _write_value(iteration_dir / "user-prompt.txt", str(iteration_input["user_prompt"]))
            iteration_exchange = iteration_trace.get("model_exchange") or {}
            if iteration_exchange:
                _write_value(iteration_dir / "model-exchange.json", iteration_exchange)
                if iteration_exchange.get("request") is not None:
                    _write_value(iteration_dir / "model-request.json", iteration_exchange["request"])
            _write_value(iteration_dir / "parsed-output.json", iteration_trace.get("parsed_output"))
            _write_value(iteration_dir / "dedupe-decisions.json", iteration_trace.get("dedupe_decisions") or [])
        output = trace.get("parsed_output")
        _write_value(stage_dir / "parsed-output.json", output)
        _write_value(intermediate_dir / f"{index:02d}-{stage_slug}.json", output)
        manifest.append(
            {
                **metadata,
                "directory": str(relative_dir).replace("\\", "/"),
                "output": f"intermediate-results/{index:02d}-{stage_slug}.json",
                "files": sorted(item.name for item in stage_dir.iterdir() if item.is_file()),
            }
        )
    checkpoints = (payload.get("task_map") or {}).get("iteration_checkpoints") or []
    checkpoint_manifest: list[dict[str, Any]] = []
    for checkpoint in checkpoints:
        iteration = int(checkpoint.get("iteration") or len(checkpoint_manifest) + 1)
        iteration_dir = run_dir / "stages" / "02-task-synthesis" / "iterations" / f"{iteration:02d}"
        _write_value(iteration_dir / "checkpoint.json", checkpoint)
        _write_value(iteration_dir / "proposed-tasks.json", checkpoint.get("proposed_tasks") or [])
        _write_value(iteration_dir / "accepted-tasks.json", checkpoint.get("accepted_tasks") or [])
        _write_value(iteration_dir / "removed-tasks.json", checkpoint.get("removed_tasks") or [])
        _write_value(iteration_dir / "retained-tasks.json", checkpoint.get("retained_tasks") or [])
        _write_value(iteration_dir / "input-pool.json", checkpoint.get("input_pool") or [])
        _write_value(iteration_dir / "output-pool.json", checkpoint.get("output_pool") or [])
        _write_value(iteration_dir / "dedupe-decisions.json", checkpoint.get("dedupe_decisions") or [])
        _write_value(iteration_dir / "iteration-control.json", checkpoint.get("iteration_control") or {})
        model_trace = checkpoint.get("model_trace") or {}
        trace_input = model_trace.get("input") or {}
        if trace_input.get("system_prompt") is not None:
            _write_value(iteration_dir / "system-prompt.txt", str(trace_input["system_prompt"]))
        if trace_input.get("user_prompt") is not None:
            _write_value(iteration_dir / "user-prompt.txt", str(trace_input["user_prompt"]))
        exchange = model_trace.get("model_exchange") or {}
        if exchange:
            _write_value(iteration_dir / "model-exchange.json", exchange)
            if exchange.get("request") is not None:
                _write_value(iteration_dir / "model-request.json", exchange["request"])
            if exchange.get("raw_response") is not None:
                _write_value(iteration_dir / "raw-response.txt", str(exchange["raw_response"]))
        _write_value(iteration_dir / "parsed-output.json", model_trace.get("parsed_output"))
        checkpoint_manifest.append({
            "iteration": iteration,
            "direction": checkpoint.get("direction"),
            "status": checkpoint.get("status"),
            "directory": f"stages/02-task-synthesis/iterations/{iteration:02d}",
            "proposed_tasks": len(checkpoint.get("proposed_tasks") or []),
            "accepted_tasks": len(checkpoint.get("accepted_tasks") or []),
            "removed_tasks": len(checkpoint.get("removed_tasks") or []),
            "retained_tasks": len(checkpoint.get("retained_tasks") or []),
        })
    _write_value(run_dir / "stage-manifest.json", {"stages": manifest, "task_iteration_checkpoints": checkpoint_manifest})


def render_skill_md(candidate: dict[str, Any]) -> str:
    skill_name = _safe_slug(str(candidate.get("skill_name") or candidate.get("skill_id") or ""))
    description = str(candidate.get("when_to_use") or candidate.get("business_goal") or "").strip()
    child_tools = candidate.get("child_tools") or []
    allowed_tools = [*child_tools, "ReturnSkillResult"]
    tool_selection = candidate.get("tool_selection") or []
    scenario_binding = candidate.get("scenario_binding") or {}
    inputs = candidate.get("input_schema") or {}
    outputs = candidate.get("output_schema") or {}
    scope = candidate.get("scope") or {}
    operating = candidate.get("operating_model") or {}
    artifact_contract = operating.get("artifact_contract") or {}
    artifact_section = ""
    if artifact_contract.get("mode") == "write_file":
        artifact_section = f"""

## Artifact contract

- Artifact type: `{artifact_contract.get('artifact_type') or 'unspecified'}`
- File name: `{artifact_contract.get('file_name_pattern') or 'unspecified'}`
- Format: `{artifact_contract.get('format') or 'unspecified'}`

Verification after writing:

{_bullets(artifact_contract.get('verification_steps') or [])}

Do not return `success` until the persisted artifact has passed these checks.
"""
    return f"""---
name: {skill_name}
description: {_json(description)}
model-entry: action-tool
allowed-tools:
{chr(10).join(f'  - {name}' for name in allowed_tools)}
---

# {candidate.get('title') or skill_name}

{operating.get('role') or candidate.get('business_goal') or ''}

## Goal

{candidate.get('business_goal', '')}

## Hard boundary

{_bullets(operating.get('hard_boundaries') or scope.get('excludes') or [])}

In scope:

{_bullets(scope.get('includes') or [])}

The scenario alone defines the domain (`{scenario_binding.get('domain_mode') or 'explicit'}`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

{_render_inputs(inputs)}

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: {', '.join(f'`{name}`' for name in child_tools) if child_tools else 'none'}.

{_bullets([f"`{item.get('tool_name')}` ({item.get('usage_mode')}): {item.get('reason')}" + (f" Condition: {item.get('condition')}." if item.get('condition') else '') + (f" Fallback: {item.get('fallback')}." if item.get('fallback') else '') for item in tool_selection if isinstance(item, dict)])}

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

{_render_workflow(operating.get('workflow') or [])}

## Decision rules

{_bullets(operating.get('decision_rules') or [])}

## Outcome rules

{_render_outcomes(operating.get('outcome_rules') or {})}
{artifact_section}

## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{_json(outputs)}
```

Declared consumers:
{_bullets(candidate.get('output_consumers') or [])}

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

{_bullets(operating.get('final_checks') or [])}
"""


def render_action_tool(candidate: dict[str, Any]) -> dict[str, Any]:
    input_config: dict[str, Any] = {}
    for name, field in (candidate.get("input_schema") or {}).items():
        field_type = str((field or {}).get("type") or "json")
        input_config[name] = {
            "type": field_type if field_type in {"string", "number", "boolean"} else "json",
            "required": bool((field or {}).get("required")),
            "description": str((field or {}).get("description") or name),
        }
    action_tool = candidate.get("action_tool") or {}
    return {
        "tool_name": candidate.get("tool_name"),
        "user_facing_name": candidate.get("title"),
        "search_hint": action_tool.get("search_hint") or candidate.get("business_goal"),
        "preserve_existing": bool(action_tool.get("preserve_existing", True)),
        "always_load": bool(action_tool.get("always_load", True)),
        "read_only": bool(action_tool.get("read_only", not bool(candidate.get("child_tools")))),
        "child_tools": candidate.get("child_tools") or [],
        "input": input_config,
    }


def build_artifact_preview(candidate: dict[str, Any]) -> dict[str, Any]:
    files = {
        "SKILL.md": render_skill_md(candidate),
        "action-tool.json": render_action_tool(candidate),
        "skilltool.json": candidate,
        "tests/eval_cases.json": candidate.get("evaluation_cases") or [],
    }
    if candidate.get("harness_tools"):
        files["harness-tools.json"] = {
            "purpose": "Deterministic tools executed by the Harness around the Skill action; these are not child_tools.",
            "tools": candidate["harness_tools"],
        }
    return {
        "skill_name": _safe_slug(str(candidate.get("skill_name") or candidate.get("skill_id") or "")),
        "files": files,
    }


def persist_run(runs_root: Path, run_id: str, payload: dict[str, Any]) -> Path:
    run_dir = runs_root / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    return persist_run_snapshot(runs_root, run_id, payload)


def persist_run_snapshot(runs_root: Path, run_id: str, payload: dict[str, Any]) -> Path:
    run_dir = runs_root / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    run_file = run_dir / "run.json"
    temporary = run_dir / "run.json.tmp"
    temporary.write_text(_json(payload) + "\n", encoding="utf-8")
    for attempt in range(4):
        try:
            temporary.replace(run_file)
            break
        except PermissionError:
            if attempt == 3:
                raise
            time.sleep(0.15 * (attempt + 1))
    persist_stage_artifacts(run_dir, payload)
    skills_dir = run_dir / "generated-skills"
    for artifact in payload.get("artifacts") or []:
        skill_dir = skills_dir / artifact["skill_name"]
        skill_dir.mkdir(parents=True, exist_ok=True)
        for relative_name, content in artifact["files"].items():
            path = skill_dir / relative_name
            _write_value(path, content)
    return run_dir
