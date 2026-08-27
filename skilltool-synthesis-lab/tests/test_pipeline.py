from __future__ import annotations

import json
from copy import deepcopy
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.mock_model import MockSynthesisModel
from pipeline.model_api import ModelConfig, OpenAICompatibleModel, chat_completions_url, extract_json
from pipeline.input_validation import validate_inputs
from pipeline.direct_synthesis import finalize_direct_result, validate_direct_candidates
from pipeline.quality import evaluate_portfolio, reconcile_candidate_contracts
from pipeline.prompts import available_tool_catalog
from pipeline.reference_skills import load_reference_harness_tool_pack
from pipeline.synthesis import PipelineError, STAGE_ORDER, SynthesisPipeline, _dedupe_task_batch, _validate_initialization_coverage, _validate_task_evolution_contract, dedupe_task_pool


def load(relative: str):
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


class ModelAPITest(unittest.TestCase):
    def test_default_model_timeout_is_five_minutes(self):
        config = ModelConfig.from_dict({"base_url": "https://example.com", "model": "test"})
        self.assertEqual(config.timeout_seconds, 300)

    def test_normalizes_chat_completions_url(self):
        self.assertEqual(chat_completions_url("https://example.com/v1"), "https://example.com/v1/chat/completions")
        self.assertEqual(chat_completions_url("https://example.com"), "https://example.com/v1/chat/completions")
        self.assertEqual(chat_completions_url("https://example.com/v1/chat/completions"), "https://example.com/v1/chat/completions")

    def test_extracts_json_from_fenced_or_prefixed_model_output(self):
        self.assertEqual(extract_json("```json\n{\"ok\": true}\n```"), {"ok": True})
        self.assertEqual(extract_json("result follows: {\"items\": [1]}"), {"items": [1]})

    def test_does_not_salvage_nested_object_from_invalid_top_level_json(self):
        with self.assertRaises(Exception):
            extract_json('{"candidates": [{"context": [...], "nested": {"ok": true}}]}')

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
        self.assertEqual(model.last_trace["endpoint"], "https://example.com/v1/chat/completions")
        self.assertNotIn("secret", json.dumps(model.last_trace))


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.profile = load("data/profiles/computer_ai_graduate.json")
        self.scenario = load("data/scenarios/industry_opportunity_discovery.json")

    def test_mock_pipeline_covers_the_complete_scene(self):
        result = SynthesisPipeline(MockSynthesisModel()).run(
            profile=self.profile,
            scenario=self.scenario,
            persist=False,
            model_mode="mock",
        )
        self.assertEqual(result["summary"]["tasks"], 9)
        self.assertEqual(len(result["task_map"]["iterations"]), 2)
        self.assertEqual(len(result["task_map"]["iteration_checkpoints"]), 2)
        self.assertEqual(result["task_map"]["iteration_checkpoints"][0]["status"], "completed")
        first_level_ids = set(result["task_map"]["iterations"][0]["retained_task_ids"])
        first_level = [item for item in result["task_map"]["tasks"] if item["task_id"] in first_level_ids]
        self.assertTrue(first_level)
        self.assertTrue(all(not item.get("dependencies") for item in first_level))
        first_input_origins = {field.get("input_origin") for item in first_level for field in item.get("inputs") or []}
        self.assertEqual(first_input_origins, {"user_provided", "tool_generated", "existing_artifact"})
        self.assertTrue(all(field.get("type") in {"object", "array", "string", "number", "boolean"} for item in first_level for field in item.get("inputs") or []))
        self.assertNotIn("prior_task_output", first_input_origins)
        later_tasks = [item for item in result["task_map"]["tasks"] if item["task_id"] not in first_level_ids]
        self.assertTrue(all(field.get("input_origin") == "prior_task_output" for item in later_tasks for field in item.get("inputs") or []))
        self.assertTrue(all(item.get("outputs") and item.get("output_hypotheses") for item in first_level))
        self.assertTrue(all(len(item.get("user_request_examples") or []) >= 2 for item in result["task_map"]["tasks"]))
        self.assertTrue(all(output.get("inferred") for item in first_level for output in item["outputs"]))
        self.assertTrue(all(output.get("output_origin") == "task_generated" for item in first_level for output in item["outputs"]))
        self.assertEqual(len(result["task_map"]["input_pool"]), sum(len(item.get("inputs") or []) for item in result["task_map"]["tasks"]))
        self.assertEqual(len(result["task_map"]["output_pool"]), sum(len(item.get("outputs") or []) for item in result["task_map"]["tasks"]))
        self.assertTrue(all(item.get("consumer_task_id") and item.get("pool_id") for item in result["task_map"]["input_pool"]))
        self.assertTrue(all(item.get("producer_task_id") and item.get("pool_id") for item in result["task_map"]["output_pool"]))
        self.assertEqual(result["task_map"]["task_dedupe_decisions"], [])
        self.assertEqual(result["model_name"], "mock")
        self.assertIn("-mock-", result["run_id"])
        self.assertEqual(result["summary"]["skilltools"], 8)
        self.assertEqual(result["quality"]["coverage"]["missing_tasks"], [])
        self.assertTrue(result["quality"]["passed"])
        self.assertEqual(result["quality"]["status"], "passed")
        self.assertNotIn("score", result["quality"])
        self.assertEqual(result["quality"]["rubric_summary"]["failed"], 0)
        self.assertEqual(len(result["quality"]["rubrics"]), 13)
        self.assertEqual(result["summary"]["quality_status"], "passed")
        self.assertEqual(result["summary"]["eligible_artifacts"], 8)
        self.assertEqual(len(result["synthesis_trace"]), 5)
        self.assertTrue(result["input_validation"]["passed"])
        self.assertTrue(all(item["description"] for item in result["input_validation"]["input_inventory"]))
        self.assertEqual(result["synthesis_trace"][0]["operation"], "deterministic_input_validation_with_task_reconciliation")
        task_trace = next(item for item in result["synthesis_trace"] if item["stage"] == "task_synthesis")
        self.assertIn("AVAILABLE ORDINARY TOOLS", task_trace["model_iterations"][0]["input"]["user_prompt"])
        self.assertIn("user_input/user_provided", task_trace["model_iterations"][0]["input"]["user_prompt"])
        self.assertIn("stable input semantics", task_trace["model_iterations"][0]["input"]["user_prompt"])
        self.assertIn("USER-EXPRESSIBILITY GATE", task_trace["model_iterations"][0]["input"]["user_prompt"])
        self.assertIn("user_request_examples", task_trace["model_iterations"][0]["input"]["user_prompt"])
        self.assertIn("TASK INPUT POOL FROM EARLIER ITERATIONS", task_trace["model_iterations"][1]["input"]["user_prompt"])
        self.assertIn("TASK OUTPUT POOL AVAILABLE TO THIS ITERATION", task_trace["model_iterations"][1]["input"]["user_prompt"])
        self.assertNotIn("NEED ANALYSIS", task_trace["model_iterations"][0]["input"]["user_prompt"])
        self.assertIn("parsed_output", result["synthesis_trace"][0])
        self.assertGreaterEqual(result["quality"]["topology"]["standalone_ratio"], 0.8)
        self.assertLessEqual(result["quality"]["topology"]["max_required_dependency_depth"], 2)
        self.assertFalse(any(item["skill_id"] == "career_stage_assessment" for item in result["final_candidates"]))
        baseline_task = next(item for item in result["task_map"]["tasks"] if item["task_id"] == "career_stage_diagnosis")
        self.assertEqual(baseline_task["synthesis_decision"], "input_only")
        inventory = {item["asset_id"]: item for item in result["task_map"]["input_inventory"]}
        self.assertEqual(inventory["profile_input"]["producer"]["kind"], "initial_input")
        self.assertEqual(inventory["user_profile"]["producer"]["kind"], "previous_scenario")
        direction = next(item for item in result["final_candidates"] if item["skill_id"] == "career_direction_hypothesis")
        self.assertEqual(direction["input_schema"]["user_context"]["source"], "user_input")
        self.assertEqual(direction["input_schema"]["user_context"]["acquisition"]["mode"], "request_user")
        live = next(item for item in result["final_candidates"] if item["skill_id"] == "live_opportunity_discovery")
        self.assertIn("WebSearch", live["child_tools"])
        self.assertTrue(all(item["reason"] for item in live["tool_selection"]))
        candidate_stage = next(item for item in result["synthesis_trace"] if item["stage"] == "candidate_synthesis")
        compact_batch = candidate_stage["model_batches"][0]
        self.assertIn("batch_task_ids", compact_batch)
        self.assertIn("candidate_ids", compact_batch["parsed_output"])
        self.assertNotIn("input", compact_batch)
        self.assertNotIn("raw_response", compact_batch["model_exchange"])
        landscape = next(item for item in result["final_candidates"] if item["skill_id"] == "industry_problem_landscape")
        self.assertNotIn("AI", json.dumps(landscape, ensure_ascii=False))

    def test_input_validation_rejects_missing_description(self):
        scenario = deepcopy(self.scenario)
        scenario["upstream_stage"]["artifacts"][0].pop("description")
        validation = validate_inputs(self.profile, scenario)
        self.assertFalse(validation["passed"])
        self.assertIn("input_description_missing", {item["code"] for item in validation["issues"]})

    def test_task_deduplication_requires_similar_inputs_outputs_and_description(self):
        retained = [{
            "task_id": "first",
            "name": "岗位族比较",
            "business_goal": "比较岗位族的职责、协作方式和进入门槛",
            "inputs": [{"name": "job_samples", "description": "待比较的真实岗位样本"}],
            "outputs": [{"name": "matrix_a", "description": "岗位族职责与门槛比较矩阵", "dedupe_key": "role_comparison"}],
        }]
        batch = [
            {
                "task_id": "wording_variant",
                "name": "岗位族对比",
                "business_goal": "对比岗位族的职责、协作方式以及进入门槛",
                "inputs": [{"name": "job_samples", "description": "需要比较的真实岗位样本"}],
                "outputs": [{"name": "different_name", "description": "岗位族职责和门槛对比矩阵", "dedupe_key": "role_comparison"}],
            },
            {
                "task_id": "new_task",
                "name": "验证行动规划",
                "business_goal": "安排未来四周的方向验证行动",
                "inputs": [{"name": "priority_directions", "description": "优先验证的职业方向"}],
                "outputs": [{"name": "action_plan", "description": "分周验证计划", "dedupe_key": "validation_action_plan"}],
            },
        ]
        accepted, decisions = _dedupe_task_batch(retained, batch, 2)
        self.assertEqual([item["task_id"] for item in accepted], ["new_task"])
        dropped = next(item for item in decisions if item["task_id"] == "wording_variant")
        self.assertEqual(dropped["duplicate_of"], "first")
        self.assertEqual(dropped["dedupe_method"], "semantic_input_output_description")
        self.assertEqual(set(dropped["similarity"]), {"inputs", "outputs", "description"})
        self.assertTrue(all(dropped["similarity"][key] >= dropped["thresholds"][key] for key in dropped["thresholds"]))

    def test_task_deduplication_keeps_same_output_for_different_input_or_goal(self):
        retained = [{
            "task_id": "role_market_matrix",
            "name": "岗位市场比较",
            "business_goal": "比较不同岗位族的市场需求",
            "inputs": [{"name": "job_postings", "description": "公开招聘岗位样本"}],
            "outputs": [{"name": "comparison", "description": "岗位市场比较矩阵", "dedupe_key": "comparison_matrix"}],
        }]
        batch = [{
            "task_id": "personal_project_matrix",
            "name": "个人项目比较",
            "business_goal": "比较个人项目的证据强度和完整性",
            "inputs": [{"name": "project_evidence", "description": "用户提供的个人项目证据"}],
            "outputs": [{"name": "comparison", "description": "个人项目比较矩阵", "dedupe_key": "comparison_matrix"}],
        }]

        accepted, decisions = _dedupe_task_batch(retained, batch, 2)

        self.assertEqual([item["task_id"] for item in accepted], ["personal_project_matrix"])
        self.assertEqual(decisions[0]["action"], "keep")

    def test_task_deduplication_removes_duplicates_within_the_same_batch(self):
        batch = [
            {
                "task_id": "first_variant",
                "name": "岗位样本整理",
                "business_goal": "整理真实岗位样本并标注职责要求",
                "inputs": [{"name": "job_links", "description": "真实岗位链接"}],
                "outputs": [{"name": "job_inventory", "description": "带职责要求的岗位样本清单", "dedupe_key": "job_sample_inventory"}],
            },
            {
                "task_id": "second_variant",
                "name": "岗位样本汇总",
                "business_goal": "汇总真实岗位样本并标注职责要求",
                "inputs": [{"name": "job_links", "description": "真实岗位链接"}],
                "outputs": [{"name": "job_samples", "description": "带职责要求的岗位样本列表", "dedupe_key": "job_sample_inventory"}],
            },
        ]

        accepted, decisions = _dedupe_task_batch([], batch, 1)

        self.assertEqual([item["task_id"] for item in accepted], ["first_variant"])
        self.assertEqual(decisions[1]["duplicate_of"], "first_variant")

    def test_task_pool_deduplication_prunes_related_pool_metadata(self):
        first = {
            "task_id": "first_variant",
            "iteration": 1,
            "name": "岗位样本整理",
            "business_goal": "整理真实岗位样本并标注职责要求",
            "inputs": [{"name": "job_links", "description": "真实岗位链接"}],
            "outputs": [{"name": "job_inventory", "description": "岗位样本清单", "dedupe_key": "job_inventory"}],
        }
        duplicate = {
            **deepcopy(first),
            "task_id": "second_variant",
            "name": "岗位样本汇总",
            "business_goal": "汇总真实岗位样本并标注职责要求",
        }
        task_map = {
            "tasks": [first, duplicate],
            "inferred_outputs": [
                {"name": "job_inventory", "producer_task_id": "first_variant"},
                {"name": "job_inventory_copy", "producer_task_id": "second_variant"},
            ],
            "coverage": [{"required_output": "岗位清单", "covered_by": ["first_variant", "second_variant"]}],
            "iterations": [{
                "iteration": 1,
                "retained_task_ids": ["first_variant", "second_variant"],
                "inferred_outputs": [
                    {"producer_task_id": "first_variant"},
                    {"producer_task_id": "second_variant"},
                ],
            }],
            "task_dedupe_decisions": [],
        }

        updated, report = dedupe_task_pool(task_map)

        self.assertEqual(report["removed_task_ids"], ["second_variant"])
        self.assertEqual([item["task_id"] for item in updated["tasks"]], ["first_variant"])
        self.assertEqual(updated["coverage"][0]["covered_by"], ["first_variant"])
        self.assertEqual(len(updated["inferred_outputs"]), 1)
        self.assertEqual(updated["input_pool"][0]["consumer_task_id"], "first_variant")
        self.assertEqual(updated["output_pool"][0]["producer_task_id"], "first_variant")
        self.assertEqual(updated["iterations"][0]["retained_task_ids"], ["first_variant", "second_variant"])
        self.assertEqual(updated["task_pool_dedupe_history"][-1]["removed_count"], 1)

    def test_natural_language_profile_and_scenario_need_no_state(self):
        profile = (ROOT / "data/profiles/computer_ai_graduate.txt").read_text(encoding="utf-8")
        scenario = (ROOT / "data/scenarios/industry_opportunity_discovery.txt").read_text(encoding="utf-8")
        result = SynthesisPipeline(MockSynthesisModel()).run(
            profile=profile,
            scenario=scenario,
            persist=False,
            model_mode="mock",
        )
        self.assertEqual(set(result["inputs"]), {"profile", "scenario"})
        self.assertTrue(result["quality"]["passed"])
        prompts = "\n".join(
            json.dumps(item.get("input") or {}, ensure_ascii=False)
            for item in result["synthesis_trace"]
        )
        self.assertNotIn("CURRENT STATE:", prompts)
        self.assertNotIn("\nSTATE:", prompts)

    def test_pipeline_advances_one_persistable_stage_at_a_time(self):
        pipeline = SynthesisPipeline(MockSynthesisModel())
        result = pipeline.create_result(
            profile=self.profile,
            scenario=self.scenario,
            model_mode="mock",
        )
        self.assertEqual(result["next_stage"], STAGE_ORDER[0])
        with self.assertRaises(PipelineError):
            pipeline.advance(result, "task_synthesis")

        for expected_stage in STAGE_ORDER:
            pipeline.advance(result, expected_stage)
            self.assertEqual(result["stages"][-1]["stage"], expected_stage)

        self.assertEqual(result["run_status"], "completed")
        self.assertIsNone(result["next_stage"])
        self.assertEqual(len(result["synthesis_trace"]), len(STAGE_ORDER))
        self.assertEqual(len(result["artifacts"]), 8)

    def test_quality_rejects_a_deep_mandatory_skill_chain(self):
        result = SynthesisPipeline(MockSynthesisModel()).run(
            profile=self.profile,
            scenario=self.scenario,
            persist=False,
            model_mode="mock",
        )
        candidates = deepcopy(result["final_candidates"])
        for index, candidate in enumerate(candidates[1:], start=1):
            previous = candidates[index - 1]
            output_name = next(iter(previous["output_schema"]))
            candidate["invocation_mode"] = "aggregate"
            candidate["input_schema"][output_name] = {
                "type": "object",
                "required": True,
                "description": "required upstream result",
                "source": "prior_skill_output",
                "available": True,
            }
        quality = evaluate_portfolio(
            candidates,
            result["task_map"],
            tool_catalog=result["tool_catalog"],
            scenario=self.scenario,
        )
        codes = {item["code"] for item in quality["portfolio_issues"]}
        self.assertFalse(quality["passed"])
        self.assertIn("standalone_ratio_too_low", codes)
        self.assertIn("root_ratio_too_low", codes)
        self.assertIn("dependency_depth_too_high", codes)

    def test_persists_compatible_skilltool_artifacts(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "runs") as directory:
            result = SynthesisPipeline(MockSynthesisModel(), runs_root=Path(directory)).run(
                profile=self.profile,
                scenario=self.scenario,
                persist=True,
                model_mode="mock",
            )
            run_dir = Path(result["run_directory"])
            self.assertTrue((run_dir / "run.json").is_file())
            stored = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(stored["run_directory"], str(run_dir))
            self.assertEqual(len(stored["synthesis_trace"]), 5)
            self.assertTrue((run_dir / "stage-manifest.json").is_file())
            self.assertTrue((run_dir / "stages/01-input-validation/parsed-output.json").is_file())
            self.assertTrue((run_dir / "stages/02-task-synthesis/iterations/01/user-prompt.txt").is_file())
            self.assertTrue((run_dir / "stages/02-task-synthesis/iterations/01/model-request.json").is_file())
            self.assertTrue((run_dir / "stages/02-task-synthesis/iterations/01/dedupe-decisions.json").is_file())
            self.assertTrue((run_dir / "stages/02-task-synthesis/iterations/01/checkpoint.json").is_file())
            self.assertTrue((run_dir / "stages/02-task-synthesis/iterations/01/proposed-tasks.json").is_file())
            self.assertTrue((run_dir / "stages/02-task-synthesis/iterations/01/retained-tasks.json").is_file())
            self.assertTrue((run_dir / "stages/02-task-synthesis/iterations/01/input-pool.json").is_file())
            self.assertTrue((run_dir / "stages/02-task-synthesis/iterations/01/output-pool.json").is_file())
            self.assertTrue((run_dir / "intermediate-results/02-task-synthesis.json").is_file())
            manifest = json.loads((run_dir / "stage-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(len(manifest["stages"]), 5)
            self.assertEqual(len(manifest["task_iteration_checkpoints"]), 2)
            skill_dir = run_dir / "generated-skills/career-direction-hypothesis"
            skill_text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("model-entry: action-tool", skill_text)
            self.assertIn("## Workflow", skill_text)
            self.assertIn("### 1. 解析输入与证据边界", skill_text)
            self.assertIn("## Outcome rules", skill_text)
            self.assertIn("## Final check before returning", skill_text)
            action = json.loads((skill_dir / "action-tool.json").read_text(encoding="utf-8"))
            self.assertEqual(action["tool_name"], "CareerDirectionHypothesis")
            self.assertEqual(action["child_tools"], [])
            self.assertTrue(action["preserve_existing"])
            self.assertTrue(action["always_load"])

    def test_persists_successful_task_round_before_a_later_round_fails(self):
        class FailsOnSecondTaskRound(MockSynthesisModel):
            def __init__(self):
                super().__init__()
                self.task_calls = 0

            def complete_json(self, *, system, user):
                if user.startswith("Discover the next batch"):
                    self.task_calls += 1
                    if self.task_calls == 2:
                        raise RuntimeError("simulated second-round failure")
                return super().complete_json(system=system, user=user)

        with tempfile.TemporaryDirectory(dir=ROOT / "runs") as directory:
            pipeline = SynthesisPipeline(FailsOnSecondTaskRound(), runs_root=Path(directory))
            with self.assertRaises(PipelineError):
                pipeline.run(profile=self.profile, scenario=self.scenario, persist=True, model_mode="mock")
            run_dir = next(Path(directory).iterdir())
            stored = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(stored["run_status"], "failed")
            self.assertEqual(len(stored["task_map"]["iteration_checkpoints"]), 1)
            self.assertTrue(stored["task_map"]["tasks"])
            self.assertTrue((run_dir / "stages/02-task-synthesis/iterations/01/checkpoint.json").is_file())

    def test_can_limit_task_synthesis_to_one_round(self):
        pipeline = SynthesisPipeline(MockSynthesisModel(), task_iteration_limit=1)
        result = pipeline.create_result(profile=self.profile, scenario=self.scenario, model_mode="mock")
        pipeline.advance(result, "input_validation")
        pipeline.advance(result, "task_synthesis")
        self.assertEqual(result["summary"]["task_iterations"], 1)
        self.assertEqual(len(result["task_map"]["iteration_checkpoints"]), 1)
        self.assertTrue(result["task_map"]["iteration_checkpoints"][0]["iteration_limit_reached"])

    def test_task_contract_failure_gets_one_corrective_model_retry(self):
        class AbstractFirstResponse(MockSynthesisModel):
            def __init__(self):
                super().__init__()
                self.task_calls = 0

            def complete_json(self, *, system, user):
                output = super().complete_json(system=system, user=user)
                if user.startswith("Discover the next batch"):
                    self.task_calls += 1
                    if self.task_calls == 1:
                        output["tasks"][0]["name"] = "职业方向假设生成"
                return output

        pipeline = SynthesisPipeline(AbstractFirstResponse(), task_iteration_limit=1)
        result = pipeline.create_result(profile=self.profile, scenario=self.scenario, model_mode="mock")
        pipeline.advance(result, "input_validation")
        pipeline.advance(result, "task_synthesis")
        checkpoint = result["task_map"]["iteration_checkpoints"][0]
        self.assertEqual(len(checkpoint["model_trace"]["attempts"]), 2)
        self.assertNotIn("假设", checkpoint["retained_tasks"][0]["name"])

    def test_seeded_pool_runs_decomposition_then_extension(self):
        first = SynthesisPipeline(MockSynthesisModel(), task_iteration_limit=1)
        seed = first.create_result(profile=self.profile, scenario=self.scenario, model_mode="mock")
        first.advance(seed, "input_validation")
        first.advance(seed, "task_synthesis")

        class EvolutionModel:
            def __init__(self):
                self.last_trace = {}

            def complete_json(self, *, system, user):
                self.last_trace = {"provider": "evolution-test", "request": {}}
                iteration = int(user.split("ITERATION: ", 1)[1].splitlines()[0])
                common = {
                    "scene": "通用职业探索",
                    "invocation_mode": "standalone",
                    "parallel_group": "career_exploration",
                    "synthesis_decision": "skilltool",
                    "decision_reason": "需要自然用户可复用的判断",
                    "execution_provider": None,
                    "need_ids": [],
                    "estimated_steps": 3,
                    "fresh_data_required": False,
                }
                if iteration == 2:
                    task = {**common, "task_id": "compare_daily_work", "name": "帮我比较这些岗位每天具体做什么", "business_goal": "让用户单独比较候选岗位的日常活动", "user_request_examples": ["帮我比较这些岗位每天做什么", "这些岗位的工作内容有什么不同"], "evolution_direction": "decomposition", "source_task_ids": ["role_family_mapping"], "inputs": [{"name": "roles", "description": "用户要比较的岗位", "type": "array", "input_origin": "user_provided", "source": "user_input", "source_ref": None, "available": False, "from_task": None, "acquisition": {"mode": "request_user", "provider": None}}], "outputs": [{"name": "daily_work_comparison", "display_name": "岗位日常工作比较", "description": "不同岗位日常活动的比较结果", "type": "object", "output_origin": "task_generated", "dedupe_key": "daily_work_comparison", "inferred": True, "consumer_tasks": [], "final_consumer": "user"}], "dependencies": []}
                else:
                    task = {**common, "task_id": "recommend_job_opportunities", "name": "帮我推荐更值得优先申请的岗位", "business_goal": "结合真实岗位与个人匹配分析给出申请顺序", "user_request_examples": ["这些岗位里我应该优先申请哪些", "结合我的情况帮我排一下申请顺序"], "evolution_direction": "extension", "source_task_ids": ["opportunity_signal_discovery", "capability_evidence_mapping"], "inputs": [{"name": "opportunities", "description": "已有真实岗位机会", "type": "object", "input_origin": "prior_task_output", "source": "prior_output", "source_ref": "opportunity_signal_discovery", "available": True, "from_task": "opportunity_signal_discovery", "acquisition": {"mode": "prior_task", "provider": "opportunity_signal_discovery"}}, {"name": "fit_evidence", "description": "已有个人与岗位匹配证据", "type": "object", "input_origin": "prior_task_output", "source": "prior_output", "source_ref": "capability_evidence_mapping", "available": True, "from_task": "capability_evidence_mapping", "acquisition": {"mode": "prior_task", "provider": "capability_evidence_mapping"}}], "outputs": [{"name": "ranked_job_recommendations", "display_name": "岗位推荐顺序", "description": "带理由和不确定性的岗位推荐顺序", "type": "array", "output_origin": "task_generated", "dedupe_key": "ranked_job_recommendations", "inferred": True, "consumer_tasks": [], "final_consumer": "user"}], "dependencies": ["opportunity_signal_discovery", "capability_evidence_mapping"]}
                tasks = [task]
                if iteration == 2:
                    second = deepcopy(task)
                    second["task_id"] = "compare_entry_requirements"
                    second["name"] = "帮我比较这些岗位的进入要求"
                    second["business_goal"] = "让用户单独比较候选岗位的进入要求"
                    second["user_request_examples"] = ["帮我比较这些岗位需要什么条件", "这些岗位哪个更容易进入"]
                    second["outputs"] = [{**second["outputs"][0], "name": "entry_requirement_comparison", "display_name": "岗位进入要求比较", "description": "不同岗位进入要求的比较结果", "dedupe_key": "entry_requirement_comparison"}]
                    tasks.append(second)
                return {"tasks": tasks, "coverage": [], "iteration_control": {"continue": iteration < 3, "reason": "执行明确的迭代计划"}}

        pipeline = SynthesisPipeline(EvolutionModel(), task_iteration_limit=3, task_iteration_start=2, task_iteration_directions=("discovery", "decomposition", "extension"))
        result = pipeline.create_result(profile=self.profile, scenario=self.scenario, model_mode="mock")
        pipeline.advance(result, "input_validation")
        result["task_map"] = deepcopy(seed["task_map"])
        pipeline.advance(result, "task_synthesis")
        checkpoints = result["task_map"]["iteration_checkpoints"]
        self.assertEqual([item.get("direction", "discovery") for item in checkpoints], ["discovery", "decomposition", "extension"])
        self.assertEqual(checkpoints[1]["accepted_tasks"][0]["source_task_ids"], ["role_family_mapping"])
        self.assertEqual(len(checkpoints[1]["accepted_tasks"]), 2)
        self.assertEqual([item["task_id"] for item in checkpoints[1]["removed_tasks"]], ["role_family_mapping"])
        self.assertNotIn("role_family_mapping", {item["task_id"] for item in result["task_map"]["tasks"]})
        self.assertEqual(len(checkpoints[2]["accepted_tasks"][0]["source_task_ids"]), 2)

    def test_extension_can_continue_from_one_task_output(self):
        task = {
            "task_id": "filter_saved_jobs",
            "evolution_direction": "extension",
            "source_task_ids": ["search_jobs"],
            "inputs": [{"source": "prior_output", "source_ref": "job_results"}],
        }
        _validate_task_evolution_contract(
            task,
            direction="extension",
            retained_tasks=[{"task_id": "search_jobs"}],
            output_pool=[{"name": "job_results", "semantic_key": "job_results", "producer_task_id": "search_jobs"}],
        )

    def test_extension_rejects_analyst_language_in_user_facing_text(self):
        task = {
            "task_id": "build_validation_loop",
            "name": "建立方向验证闭环",
            "business_goal": "形成可验证的方向假设",
            "user_request_examples": ["帮我建立证据闭环"],
            "evolution_direction": "extension",
            "source_task_ids": ["search_jobs"],
            "inputs": [{"source": "prior_output", "source_ref": "job_results"}],
        }
        with self.assertRaises(PipelineError):
            _validate_task_evolution_contract(
                task,
                direction="extension",
                retained_tasks=[{"task_id": "search_jobs"}],
                output_pool=[{"name": "job_results", "semantic_key": "job_results", "producer_task_id": "search_jobs"}],
            )

    def test_direct_synthesis_accepts_separate_harness_tools(self):
        task = {"task_id": "task_plan", "synthesis_decision": "skilltool"}
        candidate = {
            "skill_id": "plan",
            "skill_name": "plan",
            "tool_name": "Plan",
            "task_ids": ["task_plan"],
            "child_tools": [],
            "tool_selection": [],
            "operating_model": {"workflow": [{"step": 1}]},
            "harness_tools": [{
                "tool_name": "ActivatePlan",
                "purpose": "activate accepted plan state",
                "phase": "after_skill",
                "trigger": "user accepts plan",
                "steps": ["validate artifact", "store active state"],
                "input": {},
                "output": {},
                "read_only": False,
            }],
        }
        validation = validate_direct_candidates([task], [candidate])
        self.assertTrue(validation["passed"])
        result = {
            "task_map": {"tasks": [task]},
            "candidate_generation": {"raw_candidates": [candidate]},
            "summary": {},
        }
        finalize_direct_result(result, generator="test")
        self.assertEqual(result["direct_synthesis"]["validation"]["harness_tool_count"], 1)
        self.assertIn("harness-tools.json", result["artifacts"][0]["files"])

    def test_reference_harness_pack_excludes_skill_action_wrappers(self):
        references = load_reference_harness_tool_pack()
        self.assertTrue(references)
        self.assertTrue(any(item["reference_name"] == "ActivateLearningPlanTool" for item in references))
        self.assertTrue(all("executeBaselineAssessmentAction" not in item["typescript_excerpt"] for item in references))
        self.assertTrue(all("executeSkillAction" not in item["typescript_excerpt"] for item in references))

    def test_initialization_requires_broad_task_and_coverage_counts(self):
        tasks = [{"task_id": f"realistic_task_{index}"} for index in range(8)]
        coverage = [
            {"required_output": f"scenario_outcome_{index}", "covered_by": [f"realistic_task_{index}"]}
            for index in range(8)
        ]
        _validate_initialization_coverage(tasks, coverage)
        with self.assertRaises(PipelineError):
            _validate_initialization_coverage(tasks[:7], coverage[:7])
        with self.assertRaises(PipelineError):
            _validate_initialization_coverage(tasks, coverage[:-1])

    def test_catalog_matches_confirmed_career_agent_tool_list(self):
        catalog = load("data/tools/project_tools.json")
        names = {tool["name"] for tool in catalog["tools"]}
        self.assertEqual(names, {
            "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep",
            "Bash", "TaskOutput", "TaskStop", "EnterPlanMode", "ExitPlanMode",
            "TodoWrite", "Agent", "WebSearch", "WebFetch", "AskUserQuestion",
            "Skill", "ImageGenerate", "VideoGenerate", "EnterWorktree",
            "ExitWorktree", "profile_read", "profile_update", "LiveMeeting",
        })
        self.assertEqual(len(names), 24)
        by_name = {tool["name"]: tool for tool in catalog["tools"]}
        self.assertEqual(by_name["Edit"]["prerequisites"][0]["name"], "Read")
        self.assertEqual(by_name["profile_update"]["prerequisites"][0]["name"], "profile_read")
        self.assertFalse(by_name["Skill"]["selectable_for_skilltool"])
        self.assertEqual(by_name["LiveMeeting"]["implementation_status"], "missing")
        self.assertEqual(catalog["skill_candidates"][0]["name"], "lesson-generation")

    def test_catalog_entries_are_complete_and_unique(self):
        catalog = load("data/tools/project_tools.json")
        tools = catalog["tools"]
        names = [tool["name"] for tool in tools]
        self.assertEqual(len(names), len(set(names)))
        for tool in tools:
            self.assertTrue(tool.get("name"))
            self.assertTrue(tool.get("category"))
            self.assertTrue(tool.get("description"))
            self.assertTrue(tool.get("availability"))
            self.assertIn(tool.get("prerequisite_status"), catalog["dependency_types"])
            self.assertIsInstance(tool.get("prerequisites"), list)
            self.assertTrue(tool.get("typical_call_order"))
            self.assertIn(tool.get("implementation_status"), {"implemented", "missing"})
            self.assertIsInstance(tool.get("selectable_for_skilltool"), bool)

    def test_model_visible_catalog_does_not_expose_exclusion_records(self):
        catalog = load("data/tools/project_tools.json")
        visible = available_tool_catalog(catalog)
        visible_names = {tool["name"] for tool in visible["tools"]}
        self.assertEqual(len(visible_names), 17)
        self.assertIn("profile_read", visible_names)
        self.assertIn("profile_update", visible_names)
        self.assertNotIn("Skill", visible_names)
        self.assertNotIn("Agent", visible_names)
        self.assertNotIn("LiveMeeting", visible_names)
        self.assertTrue(all("prerequisites" in tool for tool in visible["tools"]))

    def test_direct_validation_enforces_career_tool_allowlist(self):
        task = {"task_id": "task", "synthesis_decision": "skilltool"}
        candidate = {
            "skill_id": "career_check",
            "skill_name": "career-check",
            "tool_name": "CareerCheck",
            "task_ids": ["task"],
            "child_tools": ["WebSearch", "WebFetch", "AskUserQuestion"],
            "tool_selection": [
                {"tool_name": name, "usage_mode": "required", "reason": "test"}
                for name in ["WebSearch", "WebFetch", "AskUserQuestion"]
            ],
            "operating_model": {"workflow": [{"step": 1}]},
        }
        validation = validate_direct_candidates(
            [task], [candidate], load("data/tools/project_tools.json")
        )
        self.assertTrue(validation["passed"])

        candidate["child_tools"] = ["SubscribePR"]
        candidate["tool_selection"] = [{
            "tool_name": "SubscribePR",
            "usage_mode": "required",
            "reason": "test",
        }]
        validation = validate_direct_candidates(
            [task], [candidate], load("data/tools/project_tools.json")
        )
        self.assertFalse(validation["passed"])
        self.assertTrue(any("allowlist" in error for error in validation["errors"]))

        candidate["child_tools"] = ["Edit"]
        candidate["tool_selection"] = [{
            "tool_name": "Edit",
            "usage_mode": "required",
            "reason": "test",
        }]
        validation = validate_direct_candidates(
            [task], [candidate], load("data/tools/project_tools.json")
        )
        self.assertFalse(validation["passed"])
        self.assertTrue(any("Edit requires Read" in error for error in validation["errors"]))

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

    def test_user_input_requires_an_explicit_request_path(self):
        result = SynthesisPipeline(MockSynthesisModel()).run(
            profile=self.profile,
            scenario=self.scenario,
            persist=False,
            model_mode="mock",
        )
        candidate = deepcopy(result["final_candidates"][0])
        candidate["input_schema"]["clarification"] = {
            "type": "string",
            "required": True,
            "description": "用户补充的目标说明",
            "source": "user_input",
            "available": False,
        }
        task_map = {
            "tasks": [{"task_id": candidate["task_ids"][0], "synthesis_decision": "skilltool"}],
            "input_inventory": result["task_map"]["input_inventory"],
        }
        quality = evaluate_portfolio(
            [candidate], task_map, tool_catalog=result["tool_catalog"], scenario=self.scenario
        )
        codes = {issue["code"] for issue in quality["candidate_reports"][0]["issues"]}
        self.assertIn("input_acquisition_missing", codes)
        candidate["input_schema"]["clarification"]["acquisition"] = {
            "mode": "request_user",
            "provider": "AskUserQuestion",
            "fallback": "返回 insufficient_input",
        }
        quality = evaluate_portfolio(
            [candidate], task_map, tool_catalog=result["tool_catalog"], scenario=self.scenario
        )
        codes = {issue["code"] for issue in quality["candidate_reports"][0]["issues"]}
        self.assertNotIn("input_acquisition_missing", codes)
        self.assertNotIn("input_unobtainable", codes)

    def test_reconciles_task_aliases_and_direct_invocation_inputs(self):
        candidates = [
            {
                "skill_id": "producer",
                "task_ids": ["task_producer"],
                "invocation_mode": "standalone",
                "input_schema": {},
                "output_schema": {"raw_samples": {"type": "array", "description": "samples"}},
                "output_consumers": ["task_consumer"],
                "child_tools": [],
            },
            {
                "skill_id": "consumer",
                "task_ids": ["task_consumer"],
                "invocation_mode": "standalone",
                "input_schema": {
                    "samples": {
                        "type": "array",
                        "required": True,
                        "source": "ordinary_tool_output",
                        "source_ref": "raw_samples",
                        "available": False,
                        "acquisition": {"mode": "ordinary_tool", "provider": "Agent", "fallback": "insufficient"},
                    }
                },
                "output_schema": {"result": {"type": "object", "description": "result"}},
                "output_consumers": ["user_decision"],
                "child_tools": [],
            },
        ]
        reconciled, changes = reconcile_candidate_contracts(candidates)
        self.assertEqual(reconciled[0]["output_consumers"], ["consumer"])
        field = reconciled[1]["input_schema"]["samples"]
        self.assertEqual(field["source"], "invocation_input")
        self.assertEqual(field["source_ref"], "raw_samples")
        self.assertTrue(field["available"])
        self.assertTrue(changes)

    def test_quality_rejects_resynthesizing_an_input_only_task(self):
        result = SynthesisPipeline(MockSynthesisModel()).run(
            profile=self.profile,
            scenario=self.scenario,
            persist=False,
            model_mode="mock",
        )
        duplicate = deepcopy(result["final_candidates"][0])
        duplicate["skill_id"] = "duplicate_profile_stage"
        duplicate["skill_name"] = "duplicate-profile-stage"
        duplicate["tool_name"] = "DuplicateProfileStage"
        duplicate["task_ids"] = ["career_stage_diagnosis"]
        duplicate["output_schema"] = {"career_profile": {"type": "object", "description": "重复生成职业画像"}}
        quality = evaluate_portfolio(
            result["final_candidates"] + [duplicate],
            result["task_map"],
            tool_catalog=result["tool_catalog"],
            scenario=self.scenario,
        )
        codes = {issue["code"] for issue in quality["portfolio_issues"]}
        self.assertIn("non_skill_task_synthesized", codes)
        boundary = next(item for item in quality["rubrics"] if item["rubric_id"] == "synthesis_boundary_and_input_reuse")
        self.assertEqual(boundary["status"], "fail")


if __name__ == "__main__":
    unittest.main()
