from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from pipeline.input_validation import validate_inputs
from pipeline.mock_model import MockSynthesisModel
from pipeline.synthesis import SynthesisPipeline
from server import bootstrap_payload, dedupe_result_task_pool, iterate_result_task_pool, list_runs, public_model_config, read_run, reject_corrupted_text, request_model_config, run_path, scenario_catalog, update_run


def sample_run(run_id: str, failed_rubrics: int = 0) -> dict:
    return {
        "run_id": run_id,
        "model_mode": "mock",
        "inputs": {"profile": {}, "state": {}, "scenario": {}},
        "task_map": {"tasks": []},
        "final_candidates": [],
        "quality": {"status": "passed" if not failed_rubrics else "needs_revision", "rubrics": [], "coverage": {}},
        "summary": {"skilltools": 0, "quality_status": "passed" if not failed_rubrics else "needs_revision", "failed_rubrics": failed_rubrics, "warning_rubrics": 0},
    }


class RunStorageApiTests(unittest.TestCase):
    def temporary_directory(self) -> tempfile.TemporaryDirectory:
        return tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)

    def test_list_and_read_runs(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            for run_id in ("run-20260815-120000-aaaaaaaa", "run-20260815-130000-bbbbbbbb"):
                run_dir = root / run_id
                run_dir.mkdir()
                (run_dir / "run.json").write_text(
                    json.dumps(sample_run(run_id)), encoding="utf-8"
                )
            (root / "unrelated").mkdir()

            runs = list_runs(root)

            self.assertEqual([item["run_id"] for item in runs], [
                "run-20260815-130000-bbbbbbbb",
                "run-20260815-120000-aaaaaaaa",
            ])
            self.assertEqual(read_run(root, runs[0]["run_id"])["summary"]["quality_status"], "passed")

    def test_update_run_is_atomic_and_keeps_identity(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            run_id = "run-20260815-120000-aaaaaaaa"
            path = root / run_id / "run.json"
            path.parent.mkdir()
            path.write_text(json.dumps(sample_run(run_id)), encoding="utf-8")
            changed = sample_run(run_id, failed_rubrics=2)

            update_run(root, run_id, changed)

            self.assertEqual(read_run(root, run_id)["summary"]["failed_rubrics"], 2)
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    def test_rejects_path_traversal_and_changed_run_id(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            run_id = "run-20260815-120000-aaaaaaaa"
            path = root / run_id / "run.json"
            path.parent.mkdir()
            path.write_text(json.dumps(sample_run(run_id)), encoding="utf-8")

            with self.assertRaises(ValueError):
                run_path(root, "../outside")
            with self.assertRaises(ValueError):
                update_run(root, run_id, sample_run("run-20260815-120000-bbbbbbbb"))

    def test_public_model_config_never_exposes_secret(self) -> None:
        public = public_model_config()
        self.assertNotIn("api_key", public)
        self.assertNotIn("api_key_env", public)
        self.assertIn("api_key_configured", public)

    def test_bootstrap_exposes_natural_language_scenario_and_non_mcp_tools(self) -> None:
        payload = bootstrap_payload()
        self.assertIsInstance(payload["scenario"], str)
        self.assertIn("已有产物 `user_profile`", payload["scenario"])
        self.assertEqual(len(payload["scenarios"]), 3)
        self.assertEqual(
            [item["scenario_id"] for item in payload["scenarios"]],
            [
                "industry_opportunity_discovery",
                "job_application_material_preparation",
                "network_application_tracking",
            ],
        )
        validation = validate_inputs(payload["profile"], payload["scenario"])
        artifacts = [item for item in validation["input_inventory"] if item.get("source") == "upstream_artifact"]
        self.assertEqual([item["asset_id"] for item in artifacts], ["user_profile"])
        self.assertFalse(any(item.get("category") == "mcp" for item in payload["tool_catalog"]["tools"]))

    def test_all_selectable_scenarios_are_valid_natural_language_inputs(self) -> None:
        profile = bootstrap_payload()["profile"]
        scenarios = scenario_catalog()
        self.assertEqual({item["name"] for item in scenarios}, {
            "职业方向探索与真实机会验证",
            "岗位材料准备",
            "人脉申请追踪",
        })
        for scenario in scenarios:
            validation = validate_inputs(profile, scenario["content"])
            self.assertTrue(validation["passed"], scenario["scenario_id"])
            self.assertIn("已有产物 `user_profile`", scenario["content"])

    def test_local_key_is_not_reused_for_another_endpoint(self) -> None:
        config = request_model_config({"base_url": "https://other.example", "model": "other"})
        self.assertEqual(config.api_key, "")

    def test_rejects_question_mark_encoding_corruption(self) -> None:
        reject_corrupted_text({"text": "正常的单个问号？ and ?"})
        with self.assertRaises(ValueError):
            reject_corrupted_text({"persona": "??????????"})

    def test_task_pool_dedupe_updates_summary(self) -> None:
        value = sample_run("run-20260815-120000-aaaaaaaa")
        task = {
            "task_id": "first",
            "name": "岗位比较",
            "business_goal": "比较岗位职责与门槛",
            "inputs": [{"name": "job_samples", "description": "岗位样本"}],
            "outputs": [{"name": "matrix", "description": "岗位比较矩阵", "dedupe_key": "role_matrix"}],
        }
        value["stages"] = [{"stage": "task_synthesis"}]
        value["task_map"] = {"tasks": [task, {**task, "task_id": "duplicate"}]}

        updated, report = dedupe_result_task_pool(value)

        self.assertEqual(report["removed_count"], 1)
        self.assertEqual(updated["summary"]["tasks"], 1)
        self.assertEqual(updated["last_task_pool_dedupe"]["after_count"], 1)
        self.assertEqual(updated["task_map"]["iterations"][-1]["direction"], "deduplication")
        self.assertEqual(updated["task_map"]["iteration_checkpoints"][-1]["direction"], "deduplication")

    def test_task_pool_dedupe_rejects_started_skilltool_synthesis(self) -> None:
        value = sample_run("run-20260815-120000-aaaaaaaa")
        value["stages"] = [{"stage": "task_synthesis"}, {"stage": "candidate_synthesis"}]
        value["task_map"] = {"tasks": [{"task_id": "task", "outputs": [{"name": "result"}]}]}

        with self.assertRaisesRegex(ValueError, "after SkillTool synthesis"):
            dedupe_result_task_pool(value)

    def test_task_pool_supports_freely_ordered_repeatable_iterations(self) -> None:
        bootstrap = bootstrap_payload()
        model = MockSynthesisModel()
        pipeline = SynthesisPipeline(
            model,
            task_iteration_limit=1,
            task_iteration_directions=("initialization",),
        )
        result = pipeline.create_result(
            profile=bootstrap["profile"],
            scenario=bootstrap["scenario"],
            model_mode="mock",
        )
        pipeline.advance(result, "input_validation")
        pipeline.advance(result, "task_synthesis")

        actions = []
        for direction in ("extension", "decomposition", "deduplication", "extension"):
            result, action = iterate_result_task_pool(result, direction, model)
            actions.append(action)

        self.assertEqual(
            [item["direction"] for item in actions],
            ["extension", "decomposition", "deduplication", "extension"],
        )
        self.assertEqual([item["iteration"] for item in actions], [2, 3, 4, 5])
        self.assertEqual(result["next_stage"], "candidate_synthesis")
        self.assertEqual(len(result["task_iteration_actions"]), 4)

    def test_task_iteration_is_locked_after_skilltool_synthesis_starts(self) -> None:
        value = sample_run("run-20260815-120000-aaaaaaaa")
        value["next_stage"] = "dedupe_merge"
        value["stages"] = [{"stage": "task_synthesis"}, {"stage": "candidate_synthesis"}]
        value["task_map"] = {"tasks": [{"task_id": "task", "outputs": [{"name": "result"}]}]}

        with self.assertRaisesRegex(ValueError, "initialized task pool"):
            iterate_result_task_pool(value, "extension", MockSynthesisModel())


if __name__ == "__main__":
    unittest.main()
