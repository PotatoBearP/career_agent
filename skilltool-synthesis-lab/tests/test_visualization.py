from __future__ import annotations

import importlib.util
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("visualization", ROOT / "tools/render_run_visualization.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class VisualizationTest(unittest.TestCase):
    def test_renders_all_skills_and_schema_fields(self):
        candidates = [
            {
                "skill_id": "first",
                "skill_name": "first",
                "title": "First",
                "tool_name": "FirstTool",
                "input_schema": {"profile": {}, "scenario": {}},
                "output_schema": {"result": {}},
                "output_consumers": ["second"],
                "child_tools": [],
            },
            {
                "skill_id": "second",
                "skill_name": "second",
                "title": "Second",
                "tool_name": "SecondTool",
                "input_schema": {"result": {}},
                "output_schema": {"decision": {}},
                "output_consumers": [],
                "child_tools": ["WebSearch"],
            },
        ]
        svg = MODULE.render({"run_id": "run-test", "final_candidates": candidates})
        ET.fromstring(svg)
        for value in ("first", "second", "profile", "scenario", "result", "decision", "WebSearch"):
            self.assertIn(value, svg)


if __name__ == "__main__":
    unittest.main()
