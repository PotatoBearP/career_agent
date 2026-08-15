#!/usr/bin/env python3
"""Render every SkillTool I/O contract in one scenario-profile run as SVG."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any


def _text(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _field_lines(fields: dict[str, Any], limit: int = 46) -> list[str]:
    lines: list[str] = []
    current = ""
    for name in fields:
        addition = name if not current else f", {name}"
        if current and len(current) + len(addition) > limit:
            lines.append(current)
            current = name
        else:
            current += addition
    if current:
        lines.append(current)
    return lines or ["—"]


def render(run: dict[str, Any]) -> str:
    candidates = run.get("final_candidates") or []
    summary = run.get("summary") or {}
    positions = {
        candidate.get("skill_name", ""): (80 + index % 3 * 505, 240 + index // 3 * 250)
        for index, candidate in enumerate(candidates)
    }
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1040" viewBox="0 0 1600 1040">',
        '<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#081225"/><stop offset="1" stop-color="#172554"/></linearGradient><filter id="shadow"><feDropShadow dy="7" stdDeviation="7" flood-opacity=".3"/></filter><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#38bdf8"/></marker></defs>',
        '<rect width="1600" height="1040" fill="url(#bg)"/>',
        '<text x="80" y="64" fill="#f8fafc" font-family="Arial,sans-serif" font-size="34" font-weight="700">Scenario × Profile SkillTool I/O Map</text>',
        f'<text x="80" y="102" fill="#94a3b8" font-family="Arial,sans-serif" font-size="17">{_text(run.get("run_id"))} · {_text(run.get("model_mode"))}</text>',
        f'<text x="80" y="140" fill="#7dd3fc" font-family="Arial,sans-serif" font-size="18">Needs {summary.get("needs", 0)} · Tasks {summary.get("tasks", 0)} · All SkillTools {len(candidates)} · Quality {summary.get("quality_score", 0)}</text>',
        '<text x="80" y="180" fill="#cbd5e1" font-family="Arial,sans-serif" font-size="14">Every SkillTool in this scenario-profile unit · IN = input_schema · OUT = output_schema · arrows = output consumers</text>',
    ]

    # Connections are placed behind cards so all contracts remain readable.
    for candidate in candidates:
        x, y = positions[candidate.get("skill_name", "")]
        for consumer in candidate.get("output_consumers") or []:
            if consumer in positions:
                target_x, target_y = positions[consumer]
                parts.append(f'<line x1="{x + 440}" y1="{y + 95}" x2="{target_x - 12}" y2="{target_y + 95}" stroke="#38bdf8" stroke-opacity=".3" stroke-width="2" marker-end="url(#arrow)"/>')

    for candidate in candidates:
        x, y = positions[candidate.get("skill_name", "")]
        inputs = _field_lines(candidate.get("input_schema") or {})
        outputs = _field_lines(candidate.get("output_schema") or {})
        tools = ", ".join(candidate.get("child_tools") or []) or "none"
        parts.extend([
            f'<rect x="{x}" y="{y}" width="440" height="205" rx="16" fill="#111c30" stroke="#475569" filter="url(#shadow)"/>',
            f'<text x="{x + 20}" y="{y + 31}" fill="#7dd3fc" font-family="monospace" font-size="13">{_text(candidate.get("skill_id"))}</text>',
            f'<text x="{x + 20}" y="{y + 61}" fill="#f8fafc" font-family="Arial,sans-serif" font-size="18" font-weight="700">{_text(candidate.get("title"))}</text>',
        ])
        cursor = y + 90
        for index, line in enumerate(inputs):
            prefix = "IN  " if index == 0 else "    "
            parts.append(f'<text x="{x + 20}" y="{cursor}" fill="#a7f3d0" font-family="monospace" font-size="12">{prefix}{_text(line)}</text>')
            cursor += 18
        for index, line in enumerate(outputs):
            prefix = "OUT " if index == 0 else "    "
            parts.append(f'<text x="{x + 20}" y="{cursor}" fill="#fde68a" font-family="monospace" font-size="12">{prefix}{_text(line)}</text>')
            cursor += 18
        parts.extend([
            f'<text x="{x + 20}" y="{y + 174}" fill="#cbd5e1" font-family="Arial,sans-serif" font-size="12">Tool: {_text(candidate.get("tool_name"))}</text>',
            f'<text x="{x + 20}" y="{y + 194}" fill="#94a3b8" font-family="Arial,sans-serif" font-size="12">Child tools: {_text(tools)}</text>',
        ])
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_json", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    run = json.loads(args.run_json.read_text(encoding="utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render(run), encoding="utf-8")


if __name__ == "__main__":
    main()
