from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

from .contracts import StageContext, StageExecution


LAB_ROOT = Path(__file__).resolve().parents[2]
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from pipeline.input_validation import validate_inputs  # noqa: E402


STAGE_NAME = "stage1_1_input_validation"


def run(context: StageContext) -> StageExecution:
    inputs = context.state["inputs"]
    started = time.perf_counter()
    validation = validate_inputs(inputs["profile"], inputs["scenario"])
    duration_ms = round((time.perf_counter() - started) * 1000)
    if not validation.get("passed"):
        issues = "; ".join(str(item.get("message") or item.get("code")) for item in validation.get("issues") or [])
        raise ValueError(f"input validation failed: {issues or 'unknown input issue'}")
    return StageExecution(
        input_payload=inputs,
        output=validation,
        state_updates={"input_validation": validation},
        trace={
            "operation": "reused_deterministic_input_validation",
            "source": "../pipeline/input_validation.py::validate_inputs",
            "duration_ms": duration_ms,
        },
        files={"input-inventory.json": validation.get("input_inventory") or []},
    )

