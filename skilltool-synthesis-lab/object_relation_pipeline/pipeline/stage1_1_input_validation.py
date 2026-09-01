from __future__ import annotations

import sys
import time
from pathlib import Path

from .contexts import context_indexes
from .contracts import StageContext, StageExecution
from .storage import write_value


LAB_ROOT = Path(__file__).resolve().parents[2]
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from pipeline.input_validation import validate_inputs  # noqa: E402


STAGE_NAME = "stage1_1_input_validation"


def run(context: StageContext) -> StageExecution:
    inputs = context.state["inputs"]
    profile_by_id, scenario_by_id = context_indexes(inputs)
    started = time.perf_counter()
    binding_validations = []
    inventory = []
    for binding in inputs.get("bindings") or []:
        profile = profile_by_id[str(binding["profile_id"])]
        scenario = scenario_by_id[str(binding["scenario_id"])]
        validation = validate_inputs(profile["content"], scenario["content"])
        record = {
            "binding_id": binding["binding_id"],
            "profile_id": profile["profile_id"],
            "scenario_id": scenario["scenario_id"],
            **validation,
        }
        binding_validations.append(record)
        for item in validation.get("input_inventory") or []:
            inventory.append({
                **item,
                "binding_id": binding["binding_id"],
                "profile_id": profile["profile_id"],
                "scenario_id": scenario["scenario_id"],
            })
        write_value(
            context.run_dir / "stages" / STAGE_NAME / "bindings" / str(binding["binding_id"]) / "validation.json",
            record,
        )
    failed = [item for item in binding_validations if not item.get("passed")]
    if failed:
        details = []
        for record in failed:
            issues = "; ".join(str(item.get("message") or item.get("code")) for item in record.get("issues") or [])
            details.append(f"{record['binding_id']}: {issues or 'unknown input issue'}")
        raise ValueError("input validation failed: " + " | ".join(details))
    validation = {
        "passed": True,
        "profile_count": len(inputs.get("profiles") or []),
        "scenario_count": len(inputs.get("scenarios") or []),
        "binding_count": len(binding_validations),
        "binding_validations": binding_validations,
        "input_inventory": inventory,
        "issues": [],
    }
    return StageExecution(
        input_payload=inputs,
        output=validation,
        state_updates={"input_validation": validation},
        trace={
            "operation": "reused_deterministic_input_validation_per_binding",
            "source": "../pipeline/input_validation.py::validate_inputs",
            "binding_count": len(binding_validations),
            "duration_ms": round((time.perf_counter() - started) * 1000),
        },
        files={"input-inventory.json": inventory, "binding-validations.json": binding_validations},
    )
