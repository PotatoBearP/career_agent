from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.mock_model import MockSynthesisModel
from pipeline.model_api import ModelConfig, OpenAICompatibleModel, chat_completions_url, extract_json
from pipeline.quality import evaluate_portfolio
from pipeline.synthesis import SynthesisPipeline


def load(relative: str):
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


class ModelAPITest(unittest.TestCase):
    def test_normalizes_chat_completions_url(self):
        self.assertEqual(chat_completions_url("https://example.com/v1"), "https://example.com/v1/chat/completions")
        self.assertEqual(chat_completions_url("https://example.com"), "https://example.com/v1/chat/completions")
        self.assertEqual(chat_completions_url("https://example.com/v1/chat/completions"), "https://example.com/v1/chat/completions")

    def test_extracts_json_from_fenced_or_prefixed_model_output(self):
        self.assertEqual(extract_json("```json\n{\"ok\": true}\n```"), {"ok": True})
        self.assertEqual(extract_json("result follows: {\"items\": [1]}"), {"items": [1]})

    def test_external_model_sends_openai_compatible_request(self):
        captured = {}

        def transport(request, timeout):
            captured["url"] = request.full_url
            captured["timeout"] = timeout
            captured["authorization"] = request.headers.get("Authorization")
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return json.dumps({"choices": [{"message": {"content": "{\"ok\":true}"}}]}).encode()

        model = OpenAICompatibleModel(
            ModelConfig(base_url="https://example.com/v1", model="test-model", api_key="secret", timeout_seconds=9),
            transport=transport,
        )
        self.assertEqual(model.complete_json(system="system", user="user"), {"ok": True})
        self.assertEqual(captured["url"], "https://example.com/v1/chat/completions")
        self.assertEqual(captured["timeout"], 9)
        self.assertEqual(captured["authorization"], "Bearer secret")
        self.assertEqual(captured["body"]["messages"][1]["content"], "user")


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.profile = load("data/profiles/computer_ai_graduate.json")
        self.state = load("data/states/exploration_state.json")
        self.scenario = load("data/scenarios/industry_opportunity_discovery.json")

    def test_mock_pipeline_covers_the_complete_scene(self):
        result = SynthesisPipeline(MockSynthesisModel()).run(
            profile=self.profile,
            state=self.state,
            scenario=self.scenario,
            persist=False,
            model_mode="mock",
        )
        self.assertEqual(result["summary"]["tasks"], 9)
        self.assertEqual(result["summary"]["skilltools"], 9)
        self.assertEqual(result["quality"]["coverage"]["missing_tasks"], [])
        self.assertTrue(result["quality"]["passed"])
        self.assertEqual(result["summary"]["eligible_artifacts"], 9)
        baseline = next(item for item in result["final_candidates"] if item["skill_id"] == "career_stage_assessment")
        self.assertEqual(baseline["child_tools"], [])
        live = next(item for item in result["final_candidates"] if item["skill_id"] == "live_opportunity_discovery")
        self.assertIn("WebSearch", live["child_tools"])
        self.assertTrue(all(item["reason"] for item in live["tool_selection"]))
        self.assertIn("scenario_interpretation", result["demand_analysis"])
        self.assertEqual(result["demand_analysis"]["scenario_interpretation"]["domain_mode"], "open")
        landscape = next(item for item in result["final_candidates"] if item["skill_id"] == "industry_problem_landscape")
        self.assertNotIn("AI", json.dumps(landscape, ensure_ascii=False))

    def test_persists_compatible_skilltool_artifacts(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "runs") as directory:
            result = SynthesisPipeline(MockSynthesisModel(), runs_root=Path(directory)).run(
                profile=self.profile,
                state=self.state,
                scenario=self.scenario,
                persist=True,
                model_mode="mock",
            )
            run_dir = Path(result["run_directory"])
            self.assertTrue((run_dir / "run.json").is_file())
            skill_dir = run_dir / "generated-skills/career-stage-assessment"
            self.assertIn("model-entry: action-tool", (skill_dir / "SKILL.md").read_text(encoding="utf-8"))
            action = json.loads((skill_dir / "action-tool.json").read_text(encoding="utf-8"))
            self.assertEqual(action["tool_name"], "CareerStageAssessment")
            self.assertEqual(action["child_tools"], [])

    def test_catalog_excludes_recursive_skill_tools(self):
        catalog = load("data/tools/project_tools.json")
        names = {tool["name"] for tool in catalog["tools"]}
        self.assertNotIn("Skill", names)
        self.assertNotIn("discover_skills", names)
        self.assertNotIn("ReturnSkillResult", names)
        self.assertIn("WebSearch", names)

    def test_quality_rejects_unlisted_or_recursive_child_tool(self):
        template = load("data/templates/skilltool_template.json")
        template.update({
            "skill_id": "recursive_candidate",
            "skill_name": "recursive-candidate",
            "tool_name": "RecursiveCandidate",
            "business_goal": "生成一个具有明确边界和消费者的结构化分析结果",
            "task_ids": ["task"],
            "tool_selection": [{"tool_name": "Skill", "usage_mode": "required", "reason": "递归", "condition": None, "fallback": None}],
            "child_tools": ["Skill"],
        })
        quality = evaluate_portfolio([template], {"tasks": [{"task_id": "task"}]}, tool_catalog=load("data/tools/project_tools.json"))
        codes = {issue["code"] for issue in quality["candidate_reports"][0]["issues"]}
        self.assertIn("recursive_skill_tool", codes)

    def test_quality_rejects_profile_driven_domain_in_open_scenario(self):
        candidate = load("data/templates/skilltool_template.json")
        candidate.update({
            "skill_id": "leaky_candidate",
            "skill_name": "leaky-candidate",
            "tool_name": "LeakyCandidate",
            "business_goal": "生成一个具有明确边界和消费者的结构化行业分析结果",
            "task_ids": ["task"],
            "scenario_binding": {"domain_source": "profile", "domain_mode": "open", "explicit_domains": ["人工智能"], "profile_role": "domain_selector"},
            "tool_selection": [],
            "child_tools": [],
        })
        quality = evaluate_portfolio([candidate], {"tasks": [{"task_id": "task"}]}, scenario=self.scenario)
        codes = {issue["code"] for issue in quality["candidate_reports"][0]["issues"]}
        self.assertIn("profile_scenario_leakage", codes)

    def test_quality_gate_rejects_unavailable_inputs_and_unconsumed_outputs(self):
        candidate = {
            "skill_id": "bad_skill",
            "skill_name": "bad-skill",
            "tool_name": "BadSkill",
            "business_goal": "做一个仍然有一定长度但无法运行的分析结果",
            "task_ids": ["task"],
            "input_schema": {"secret": {"type": "string", "required": True, "source": "main_database", "available": False}},
            "output_schema": {"result": {"type": "object", "description": "结果"}},
            "output_consumers": [],
            "child_tools": [],
            "complexity": {"level": "bounded", "estimated_steps": 3},
            "independence": {"portable": False, "assumptions": ["requires main program route"]},
            "evaluation_cases": [],
        }
        quality = evaluate_portfolio([candidate], {"tasks": [{"task_id": "task"}]})
        self.assertFalse(quality["passed"])
        codes = {issue["code"] for issue in quality["candidate_reports"][0]["issues"]}
        self.assertIn("input_unknown_source", codes)
        self.assertIn("output_no_consumer", codes)
        self.assertIn("main_program_coupling", codes)


if __name__ == "__main__":
    unittest.main()
