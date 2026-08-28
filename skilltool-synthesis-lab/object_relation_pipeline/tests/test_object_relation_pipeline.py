from __future__ import annotations

import tempfile
import json
import threading
import unittest
import urllib.request
from copy import deepcopy
from http.server import ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LAB_ROOT = ROOT.parent

import sys
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from object_relation_pipeline.pipeline.contracts import STAGE_ORDER, StageContext  # noqa: E402
from object_relation_pipeline.pipeline.modeling import build_models  # noqa: E402
from object_relation_pipeline.pipeline.prompts import p1_generation_prompt, p1_validation_prompt, relation_extraction_prompt  # noqa: E402
from object_relation_pipeline.pipeline.runner import PipelineRunner, resolve_stage  # noqa: E402
from object_relation_pipeline.pipeline.stage3_1_relation_sampling import run as run_sampling  # noqa: E402
from object_relation_pipeline.pipeline.stage3_3_p1_task_validation import deterministic_issues  # noqa: E402
from object_relation_pipeline.pipeline.stage2_2_object_clustering import _project_semantic_role  # noqa: E402
from object_relation_pipeline.pipeline.stage4_1_skill_generation import RUNTIME_INPUT_BOUNDARY, _p1_task_map, _replace_task_references_with_skill_names  # noqa: E402
from object_relation_pipeline.pipeline.stage4_2_artifact_finalization import validate_runtime_metadata_boundaries  # noqa: E402
from object_relation_pipeline.pipeline.storage import create_state  # noqa: E402
from object_relation_pipeline import server as web_server  # noqa: E402


class ObjectRelationPipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.profile = (LAB_ROOT / "data/profiles/computer_ai_graduate.txt").read_text(encoding="utf-8")
        self.scenario = (LAB_ROOT / "data/scenarios/industry_opportunity_discovery.txt").read_text(encoding="utf-8")

    def state(self, run_id: str = "orun-test-pipeline") -> dict:
        return create_state(
            run_id=run_id,
            profile=self.profile,
            scenario=self.scenario,
            model_mode="mock",
            model_name="mock",
            options={"sampling": {
                "seed": 17,
                "target_count": 3,
                "candidate_multiplier": 2,
                "k_min": 1,
                "k_max": 2,
                "mode": "constrained",
            }},
        )

    def runner(self, root: Path) -> PipelineRunner:
        base, relation, _ = build_models("mock", {})
        return PipelineRunner(runs_root=root, base_model=base, relation_model=relation)

    def test_full_mock_pipeline_persists_every_stage_and_skill(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = self.runner(root).run_interval(
                self.state(), from_stage="stage1_1", to_stage="stage4_2"
            )
            self.assertEqual(state["completed_stages"], list(STAGE_ORDER))
            self.assertEqual(state["run_status"], "completed")
            self.assertGreaterEqual(state["summary"]["p0_tasks"], 8)
            self.assertEqual(state["summary"]["latent_relations"], state["summary"]["p0_tasks"])
            self.assertGreater(state["summary"]["canonical_objects"], 1)
            self.assertEqual(state["summary"]["p1_tasks"], 3)
            self.assertEqual(state["summary"]["skills"], 3)
            for relation in state["latent_relations"]:
                self.assertGreaterEqual(relation["m"], 1)
                self.assertGreaterEqual(relation["n"], 1)
            for task in state["p1_tasks"]:
                contract = task["relation_contract"]
                self.assertEqual(len(task["inputs"]), contract["k"])
                self.assertEqual(
                    sorted(item["object_id"] for item in task["inputs"]),
                    sorted(contract["input_object_ids"]),
                )
                self.assertEqual(task["outputs"][0]["object_id"], contract["output_object_id"])
            run_dir = root / state["run_id"]
            for stage in STAGE_ORDER:
                stage_dir = run_dir / "stages" / stage
                for name in ("stage.json", "input.json", "output.json", "trace.json"):
                    self.assertTrue((stage_dir / name).is_file(), f"{stage}/{name}")
            self.assertTrue((
                run_dir / "stages/stage2_2_object_clustering/relation-semantic-projections.json"
            ).is_file())
            metadata_report = json.loads((
                run_dir / "stages/stage4_2_artifact_finalization/runtime-metadata-validation.json"
            ).read_text(encoding="utf-8"))
            self.assertTrue(metadata_report["passed"])
            generated = list((run_dir / "generated-skills").iterdir())
            self.assertEqual(len(generated), 3)
            self.assertTrue(all((item / "relation-contract.json").is_file() for item in generated))

    def test_pipeline_can_run_in_custom_intervals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = self.runner(root)
            state = runner.run_interval(self.state("orun-test-interval"), from_stage="stage1_1", to_stage="stage2_2")
            self.assertEqual(state["next_stage"], "stage3_1_relation_sampling")
            state = runner.run_interval(state, from_stage="stage3_1", to_stage="stage3_3")
            self.assertEqual(state["next_stage"], "stage4_1_skill_generation")
            state = runner.run_interval(state, from_stage="stage4_1", to_stage="stage4_2")
            self.assertEqual(state["run_status"], "completed")
            self.assertEqual(resolve_stage("stage2_1"), "stage2_1_relation_extraction")

    def test_sampling_is_seed_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = self.runner(root)
            state = runner.run_interval(self.state("orun-test-seed"), from_stage="stage1_1", to_stage="stage2_2")
            _, relation_a, _ = build_models("mock", {})
            _, relation_b, _ = build_models("mock", {})
            first = run_sampling(StageContext(deepcopy(state), root / "a", None, relation_a)).output["sampled_relations"]
            second = run_sampling(StageContext(deepcopy(state), root / "b", None, relation_b)).output["sampled_relations"]
            self.assertEqual(
                [item["relation_signature"] for item in first],
                [item["relation_signature"] for item in second],
            )

    def test_p1_validation_does_not_compare_against_p0(self) -> None:
        relation = {
            "relation_id": "sample_relation_001",
            "input_object_ids": ["obj_input"],
            "output_object_id": "obj_output",
            "k": 1,
        }
        task = {
            "task_id": "p1_task_001",
            "name": "与 P0 完全相同的名称",
            "business_goal": "与 P0 完全相同的目标",
            "user_request_examples": ["请求一", "请求二"],
            "relation_contract": {
                "relation_id": "sample_relation_001",
                "input_object_ids": ["obj_input"],
                "output_object_id": "obj_output",
                "k": 1,
            },
            "inputs": [{"object_id": "obj_input", "acquisition": {"mode": "request_user"}}],
            "outputs": [{"object_id": "obj_output"}],
        }
        self.assertEqual(deterministic_issues(task, relation), [])
        prompt = p1_validation_prompt(task, relation, [
            {"object_id": "obj_input"}, {"object_id": "obj_output"}
        ], "测试场景")
        self.assertIn("Do NOT compare this task with P0 tasks", prompt)

    def test_relation_projection_only_collapses_shared_semantic_cluster(self) -> None:
        projected, collapses = _project_semantic_role(
            ["mention_a", "mention_b", "mention_c"],
            {
                "mention_a": "obj_semantic_a",
                "mention_b": "obj_semantic_a",
                "mention_c": "obj_same_name_but_distinct_cluster",
            },
            {
                "obj_semantic_a": {"reason": "LLM judged the two mentions interchangeable"},
                "obj_same_name_but_distinct_cluster": {"reason": "singleton"},
            },
        )
        self.assertEqual(projected, ["obj_semantic_a", "obj_same_name_but_distinct_cluster"])
        self.assertEqual(len(collapses), 1)
        self.assertEqual(collapses[0]["basis"], "shared_llm_semantic_cluster")
        self.assertEqual(collapses[0]["source_mention_ids"], ["mention_a", "mention_b"])

    def test_prompts_forbid_pipeline_metadata_as_runtime_information(self) -> None:
        extraction = relation_extraction_prompt({"task_id": "p0_task_001", "name": "测试"}, "测试场景")
        self.assertIn("Never emit task IDs", extraction)
        generation = p1_generation_prompt(
            {
                "relation_id": "sample_relation_001",
                "input_object_ids": ["obj_input"],
                "output_object_id": "obj_output",
            },
            [
                {"object_id": "obj_input", "name": "domain_input", "acquisition_options": ["user_input"]},
                {"object_id": "obj_output", "name": "domain_output", "acquisition_options": []},
            ],
            "测试场景",
            {"tools": []},
        )
        self.assertIn("private design-time controls", generation)
        self.assertIn("relation_contract", generation)
        self.assertIn("Never place it in input_schema", RUNTIME_INPUT_BOUNDARY)

    def test_skill_task_map_strips_relation_metadata_from_runtime_contract(self) -> None:
        task_map = _p1_task_map({"p1_tasks": [{
            "task_id": "p1_task_001",
            "name": "领域任务",
            "business_goal": "生成领域结果",
            "user_request_examples": ["请处理这些领域信息", "请给出结果"],
            "invocation_mode": "standalone",
            "synthesis_decision": "skilltool",
            "decision_reason": "测试",
            "fresh_data_required": False,
            "inputs": [{
                "name": "domain_information",
                "display_name": "领域信息",
                "description": "真实领域信息",
                "type": "object",
                "required": True,
                "object_id": "obj_internal_input",
                "input_origin": "user_provided",
                "source": "user_input",
                "source_ref": "obj_internal_input",
                "available": False,
                "acquisition": {"mode": "request_user", "provider": None},
            }],
            "outputs": [{
                "name": "domain_result",
                "display_name": "领域结果",
                "description": "真实领域结果",
                "type": "object",
                "object_id": "obj_internal_output",
                "final_consumer": "user",
            }],
            "relation_contract": {"relation_id": "sample_relation_001"},
        }]})
        prompt_task = task_map["tasks"][0]
        self.assertNotIn("relation_contract", prompt_task)
        self.assertNotIn("object_id", prompt_task["inputs"][0])
        self.assertIsNone(prompt_task["inputs"][0]["source_ref"])
        self.assertEqual(prompt_task["outputs"][0]["dedupe_key"], "domain_result")
        serialized = json.dumps(task_map, ensure_ascii=False)
        self.assertNotIn("obj_internal_input", serialized)
        self.assertNotIn("obj_internal_output", serialized)

    def test_final_runtime_metadata_validator_rejects_leakage(self) -> None:
        candidate = {
            "skill_id": "safe_skill",
            "skill_name": "safe-skill",
            "tool_name": "SafeSkill",
            "task_ids": ["p1_task_001"],
            "relation_contract": {"relation_id": "sample_relation_001"},
            "input_schema": {
                "domain_information": {
                    "type": "object",
                    "description": "真实领域信息",
                    "source": "user_input",
                }
            },
            "output_schema": {"domain_result": {"type": "object"}},
            "operating_model": {"workflow": [{"instructions": ["根据领域信息生成结果"]}]},
        }
        clean = validate_runtime_metadata_boundaries([candidate])
        self.assertTrue(clean["passed"])
        leaked = deepcopy(candidate)
        leaked["input_schema"]["p1_task_id"] = leaked["input_schema"].pop("domain_information")
        report = validate_runtime_metadata_boundaries([leaked])
        self.assertFalse(report["passed"])
        self.assertEqual(report["violations"][0]["code"], "task_id_field")
        self.assertIn("input_schema", report["violations"][0]["path"])

    def test_prior_task_references_are_replaced_with_skill_names(self) -> None:
        candidates = [
            {
                "skill_id": "producer",
                "skill_name": "producer-skill",
                "task_ids": ["p1_task_001"],
                "input_schema": {},
                "output_consumers": ["p1_task_002"],
            },
            {
                "skill_id": "consumer",
                "skill_name": "consumer-skill",
                "task_ids": ["p1_task_002"],
                "input_schema": {
                    "prior_result": {
                        "acquisition": {"mode": "prior_skill", "provider": "p1_task_001"}
                    }
                },
                "output_consumers": ["user_decision"],
            },
        ]
        _replace_task_references_with_skill_names(candidates)
        self.assertEqual(candidates[0]["output_consumers"], ["consumer-skill"])
        self.assertEqual(
            candidates[1]["input_schema"]["prior_result"]["acquisition"]["provider"],
            "producer-skill",
        )

    def test_http_api_runs_a_custom_interval(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            original_root = web_server.RUNS_ROOT
            web_server.RUNS_ROOT = Path(directory)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), web_server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                base_url = f"http://127.0.0.1:{httpd.server_port}"
                bootstrap = json.loads(opener.open(base_url + "/api/bootstrap").read())
                self.assertEqual(len(bootstrap["stage_order"]), len(STAGE_ORDER))
                request = urllib.request.Request(
                    base_url + "/api/run",
                    data=json.dumps({
                        "mode": "mock",
                        "profile": self.profile,
                        "scenario": self.scenario,
                        "from_stage": "stage1_1",
                        "to_stage": "stage2_2",
                        "sampling": {
                            "seed": 3,
                            "target_count": 2,
                            "candidate_multiplier": 2,
                            "k_min": 1,
                            "k_max": 2,
                            "mode": "constrained",
                        },
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                result = json.loads(opener.open(request, timeout=20).read())
                self.assertEqual(result["next_stage"], "stage3_1_relation_sampling")
                self.assertGreater(result["summary"]["canonical_objects"], 1)
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=5)
                web_server.RUNS_ROOT = original_root

    def test_web_model_config_exposes_and_accepts_generation_limits(self) -> None:
        public = web_server.public_model_config()
        self.assertEqual(public["max_tokens"], 6000)
        self.assertEqual(public["timeout_seconds"], 120)
        self.assertNotIn("api_key", public)
        merged = web_server.request_model_config({
            "temperature": 0.4,
            "max_tokens": 24000,
            "timeout_seconds": 300,
        })
        self.assertEqual(merged["temperature"], 0.4)
        self.assertEqual(merged["max_tokens"], 24000)
        self.assertEqual(merged["timeout_seconds"], 300)


if __name__ == "__main__":
    unittest.main()
