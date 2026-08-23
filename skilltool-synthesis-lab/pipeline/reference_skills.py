from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any


DEFAULT_REFERENCE_ROOT = Path(__file__).resolve().parents[1] / "ref" / "skills"
DEFAULT_REFERENCE_TOOL_ROOT = Path(__file__).resolve().parents[1] / "ref" / "tools"


def _runtime_excerpt(text: str, *, max_chars: int = 4500) -> str:
    """Keep representative instructions from every section without a huge prompt."""

    lines = text.splitlines()
    selected: list[str] = []
    content_lines = 0
    in_frontmatter = False
    for index, line in enumerate(lines):
        if index == 0 and line.strip() == "---":
            in_frontmatter = True
        if in_frontmatter:
            selected.append(line)
            if index > 0 and line.strip() == "---":
                in_frontmatter = False
            continue
        if line.startswith("#"):
            selected.extend(["", line])
            content_lines = 0
            continue
        if not line.strip():
            continue
        if content_lines < 8:
            selected.append(line)
            content_lines += 1
        if len("\n".join(selected)) >= max_chars:
            break
    return "\n".join(selected)[:max_chars].rstrip()


@lru_cache(maxsize=4)
def load_reference_skill_pack(reference_root: str | None = None) -> list[dict[str, Any]]:
    """Load user-provided runtime Skills as synthesis exemplars."""

    root = Path(reference_root) if reference_root else DEFAULT_REFERENCE_ROOT
    if not root.is_dir():
        return []

    references: list[dict[str, Any]] = []
    for skill_dir in sorted(path for path in root.iterdir() if path.is_dir()):
        skill_path = skill_dir / "SKILL.md"
        action_path = skill_dir / "action-tool.json"
        if not skill_path.is_file() or not action_path.is_file():
            continue
        try:
            action_tool = json.loads(action_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        references.append(
            {
                "reference_name": skill_dir.name,
                "skill_md_excerpt": _runtime_excerpt(skill_path.read_text(encoding="utf-8")),
                "action_tool": action_tool,
            }
        )
    return references


def reference_design_principles() -> list[str]:
    return [
        "Write a precise trigger description with explicit negative boundaries.",
        "Give the child model a concrete role and freeze the evidence or data boundary when the capability requires it.",
        "Use an ordered workflow whose steps name inputs, transformations, decision rules, tool calls, persisted artifacts, and success criteria.",
        "Define success, insufficient_input, and error as distinct outcomes; missing evidence is normally insufficient_input, not error.",
        "State deterministic rubrics, rankings, calculations, freshness rules, or conflict handling wherever the business decision depends on them.",
        "Make the output contract field-level and define artifact write/read-back verification when a file is canonical.",
        "End with a concrete pre-return checklist and exactly one ReturnSkillResult call.",
        "Keep maintenance-only examples and verifier guidance out of runtime instructions.",
    ]


@lru_cache(maxsize=4)
def load_reference_harness_tool_pack(
    reference_root: str | None = None,
) -> list[dict[str, Any]]:
    """Load concise deterministic Harness Tool examples from ref/tools.

    Skill action wrappers are excluded because they demonstrate invoking a Skill,
    not the small before/after lifecycle tools requested here.
    """

    root = Path(reference_root) if reference_root else DEFAULT_REFERENCE_TOOL_ROOT
    if not root.is_dir():
        return []
    references: list[dict[str, Any]] = []
    for path in sorted(root.glob("*/*.ts")):
        if path.name == "artifactAdapter.ts":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if re.search(r"execute[A-Za-z0-9]*Action", text):
            continue
        references.append(
            {
                "reference_name": path.stem,
                "relative_path": str(path.relative_to(root.parent.parent)).replace("\\", "/"),
                "typescript_excerpt": text[:3500].rstrip(),
            }
        )
    return references[:6]
