from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", value.lower().replace("_", "-")).strip("-")
    if not slug:
        raise ValueError("Skill candidate has no safe skill_name")
    return slug[:64]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def render_skill_md(candidate: dict[str, Any]) -> str:
    skill_name = _safe_slug(str(candidate.get("skill_name") or candidate.get("skill_id") or ""))
    description = str(candidate.get("when_to_use") or candidate.get("business_goal") or "").strip()
    child_tools = candidate.get("child_tools") or []
    tool_selection = candidate.get("tool_selection") or []
    scenario_binding = candidate.get("scenario_binding") or {}
    inputs = candidate.get("input_schema") or {}
    outputs = candidate.get("output_schema") or {}
    return f"""---
name: {skill_name}
description: {description}
model-entry: action-tool
---

# {candidate.get('title') or skill_name}

## Business goal

{candidate.get('business_goal', '')}

## Scope

Included:
{chr(10).join(f'- {item}' for item in (candidate.get('scope') or {}).get('includes', []))}

Excluded:
{chr(10).join(f'- {item}' for item in (candidate.get('scope') or {}).get('excludes', []))}

## Scenario binding

```json
{_json(scenario_binding)}
```

The scenario defines the domain. Profile data is evidence only and must never silently redefine the scenario.

## Runtime contract

- Run as a standalone child model through the configured external API.
- Treat `<skill-action-input>` as the invocation input.
- Use only the declared non-Skill child tools: {', '.join(child_tools) if child_tools else 'none'}.
- Never discover or invoke another Skill from inside this SkillTool.
- Do not depend on main-program routes, state, databases, or implementation details.
- Preserve evidence sources and expose material uncertainty.
- Call `ReturnSkillResult` exactly once before completing.

## Auxiliary tool policy

```json
{_json(tool_selection)}
```

`required` tools are part of the normal path. `optional` and `conditional` tools must only be called under their declared conditions; otherwise follow their fallback. An empty list means the child model must reason only over supplied inputs.

## Input schema

```json
{_json(inputs)}
```

If a required input cannot be obtained under the declared tool policy, return `insufficient_input`.

## Output schema

Pass a JSON object matching this schema-like contract as `result`:

```json
{_json(outputs)}
```

Declared consumers:
{chr(10).join(f'- {item}' for item in candidate.get('output_consumers') or [])}

## Completion

Call `ReturnSkillResult` with the Harness-provided `skill_call_id` and `skill_name`, one of `success`, `insufficient_input`, or `error`, a concise summary, and the structured result.
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
    return {
        "tool_name": candidate.get("tool_name"),
        "user_facing_name": candidate.get("title"),
        "search_hint": candidate.get("business_goal"),
        "preserve_existing": False,
        "always_load": False,
        "read_only": not bool(candidate.get("child_tools")),
        "child_tools": candidate.get("child_tools") or [],
        "input": input_config,
    }


def build_artifact_preview(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "skill_name": _safe_slug(str(candidate.get("skill_name") or candidate.get("skill_id") or "")),
        "files": {
            "SKILL.md": render_skill_md(candidate),
            "action-tool.json": render_action_tool(candidate),
            "skilltool.json": candidate,
            "tests/eval_cases.json": candidate.get("evaluation_cases") or [],
        },
    }


def persist_run(runs_root: Path, run_id: str, payload: dict[str, Any]) -> Path:
    run_dir = runs_root / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(_json(payload) + "\n", encoding="utf-8")
    skills_dir = run_dir / "generated-skills"
    for artifact in payload.get("artifacts") or []:
        skill_dir = skills_dir / artifact["skill_name"]
        skill_dir.mkdir(parents=True, exist_ok=False)
        for relative_name, content in artifact["files"].items():
            path = skill_dir / relative_name
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, str):
                serialized = content
            else:
                serialized = _json(content) + "\n"
            path.write_text(serialized, encoding="utf-8")
    return run_dir
