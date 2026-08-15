from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def persist_step_json(
    runs_root: Path,
    run_id: str,
    step_directory: str,
    files: dict[str, Any],
) -> Path:
    """Persist a completed step immediately so later failures do not erase it."""
    step_dir = runs_root / run_id / step_directory
    step_dir.mkdir(parents=True, exist_ok=False)
    for name, content in files.items():
        serialized = json.dumps(content, ensure_ascii=False, indent=2) + "\n"
        (step_dir / name).write_text(serialized, encoding="utf-8")
    return step_dir
