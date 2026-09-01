from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
LAB_ROOT = ROOT.parent
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from object_relation_pipeline.pipeline.contracts import STAGE_ORDER  # noqa: E402
from object_relation_pipeline.pipeline.modeling import build_models  # noqa: E402
from object_relation_pipeline.pipeline.runner import PipelineRunner, resolve_stage  # noqa: E402
from object_relation_pipeline.pipeline.storage import create_state, load_state, new_run_id, save_state  # noqa: E402


RUNS_ROOT = ROOT / "runs"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def model_config(path: Path | None) -> dict[str, Any]:
    example = LAB_ROOT / "data/model_config.example.json"
    config = load_json(example)
    local = LAB_ROOT / "data/model_config.local.json"
    if local.is_file():
        config.update(load_json(local))
    if path is not None:
        config.update(load_json(path))
    return config


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--run-id", help="Continue an existing run; omit to create one.")
    parser.add_argument("--mode", choices=("mock", "api"), default="mock")
    parser.add_argument("--config", type=Path, help="OpenAI-compatible model config JSON.")
    parser.add_argument("--profile", type=Path, action="append", help="Profile text file; repeat for multiple profiles.")
    parser.add_argument("--scenario", type=Path, action="append", help="Scenario text file; repeat for multiple scenarios.")
    parser.add_argument("--context-config", type=Path, help="JSON containing profiles, scenarios, optional bindings and p0 options.")
    parser.add_argument("--p0-target-count", type=int)
    parser.add_argument("--cross-scenario-ratio", type=float)
    parser.add_argument("--max-bindings", type=int)
    parser.add_argument("--bridge-tasks-per-group", type=int)
    parser.add_argument("--p0-min-complexity-score", type=float)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--target-count", type=int)
    parser.add_argument("--candidate-multiplier", type=int)
    parser.add_argument("--k-min", type=int)
    parser.add_argument("--k-max", type=int)
    parser.add_argument("--sampling-mode", choices=("random", "constrained"))


def execute(args: argparse.Namespace, *, from_stage: str, to_stage: str) -> dict[str, Any]:
    config = model_config(args.config)
    if args.run_id:
        state = load_state(RUNS_ROOT, args.run_id)
        mode = state.get("model_mode") or args.mode
    else:
        mode = args.mode
    base_model, relation_model, model_name = build_models(mode, config)
    if not args.run_id:
        run_id = new_run_id(model_name)
        sampling_options = {
            "seed": args.seed if args.seed is not None else 20260827,
            "target_count": args.target_count if args.target_count is not None else 8,
            "candidate_multiplier": args.candidate_multiplier if args.candidate_multiplier is not None else 3,
            "k_min": args.k_min if args.k_min is not None else 1,
            "k_max": args.k_max if args.k_max is not None else 3,
            "mode": args.sampling_mode or "constrained",
        }
        context_config = load_json(args.context_config) if args.context_config else {}
        profile_paths = args.profile or [LAB_ROOT / "data/profiles/computer_ai_graduate.txt"]
        scenario_paths = args.scenario or [LAB_ROOT / "data/scenarios/industry_opportunity_discovery.txt"]
        profiles = context_config.get("profiles") or [
            {"profile_id": f"profile_{index:03d}", "name": path.stem, "content": path.read_text(encoding="utf-8").strip()}
            for index, path in enumerate(profile_paths, 1)
        ]
        scenarios = context_config.get("scenarios") or [
            {"scenario_id": f"scenario_{index:03d}", "name": path.stem, "content": path.read_text(encoding="utf-8").strip()}
            for index, path in enumerate(scenario_paths, 1)
        ]
        p0_options = {
            **dict(context_config.get("p0") or {}),
            **{key: value for key, value in {
                "target_count": args.p0_target_count,
                "cross_scenario_ratio": args.cross_scenario_ratio,
                "max_bindings": args.max_bindings,
                "bridge_tasks_per_group": args.bridge_tasks_per_group,
                "min_complexity_score": args.p0_min_complexity_score,
            }.items() if value is not None},
        }
        options = {"sampling": sampling_options, "p0": p0_options}
        state = create_state(
            run_id=run_id,
            profiles=profiles,
            scenarios=scenarios,
            bindings=context_config.get("bindings"),
            model_mode=mode,
            model_name=model_name,
            options=options,
        )
        run_dir = RUNS_ROOT / run_id
        run_dir.mkdir(parents=True, exist_ok=False)
        save_state(run_dir, state)
    elif "stage3_1_relation_sampling" not in (state.get("completed_stages") or []):
        overrides = {
            "seed": args.seed,
            "target_count": args.target_count,
            "candidate_multiplier": args.candidate_multiplier,
            "k_min": args.k_min,
            "k_max": args.k_max,
            "mode": args.sampling_mode,
        }
        current = state.setdefault("options", {}).setdefault("sampling", {})
        current.update({key: value for key, value in overrides.items() if value is not None})
        if "stage1_2_context_binding_planning" not in (state.get("completed_stages") or []):
            p0_overrides = {
                "target_count": args.p0_target_count,
                "cross_scenario_ratio": args.cross_scenario_ratio,
                "max_bindings": args.max_bindings,
                "bridge_tasks_per_group": args.bridge_tasks_per_group,
                "min_complexity_score": args.p0_min_complexity_score,
            }
            state.setdefault("options", {}).setdefault("p0", {}).update(
                {key: value for key, value in p0_overrides.items() if value is not None}
            )
        save_state(RUNS_ROOT / state["run_id"], state)
    runner = PipelineRunner(runs_root=RUNS_ROOT, base_model=base_model, relation_model=relation_model)

    def progress(stage: str, status: str) -> None:
        print(f"[{status}] {stage}", flush=True)

    return runner.run_interval(
        state,
        from_stage=resolve_stage(from_stage),
        to_stage=resolve_stage(to_stage),
        progress_callback=progress,
    )


def print_result(state: dict[str, Any]) -> None:
    print(json.dumps({
        "run_id": state.get("run_id"),
        "run_status": state.get("run_status"),
        "next_stage": state.get("next_stage"),
        "summary": state.get("summary"),
        "run_directory": str(RUNS_ROOT / state["run_id"]),
    }, ensure_ascii=False, indent=2))
