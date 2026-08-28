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
    parser.add_argument("--profile", type=Path, default=LAB_ROOT / "data/profiles/computer_ai_graduate.txt")
    parser.add_argument("--scenario", type=Path, default=LAB_ROOT / "data/scenarios/industry_opportunity_discovery.txt")
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
        options = {"sampling": sampling_options}
        state = create_state(
            run_id=run_id,
            profile=args.profile.read_text(encoding="utf-8").strip(),
            scenario=args.scenario.read_text(encoding="utf-8").strip(),
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
