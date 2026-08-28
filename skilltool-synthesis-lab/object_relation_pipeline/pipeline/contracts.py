from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


STAGE_ORDER = (
    "stage1_1_input_validation",
    "stage1_2_p0_task_synthesis",
    "stage2_1_relation_extraction",
    "stage2_2_object_clustering",
    "stage3_1_relation_sampling",
    "stage3_2_p1_task_generation",
    "stage3_3_p1_task_validation",
    "stage4_1_skill_generation",
    "stage4_2_artifact_finalization",
)


@dataclass
class StageContext:
    state: dict[str, Any]
    run_dir: Path
    base_model: Any
    relation_model: Any
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class StageExecution:
    input_payload: dict[str, Any]
    output: dict[str, Any]
    state_updates: dict[str, Any]
    trace: dict[str, Any] = field(default_factory=dict)
    files: dict[str, Any] = field(default_factory=dict)

