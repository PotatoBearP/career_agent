from __future__ import annotations

import time
import uuid
from datetime import datetime
import json
import re
from copy import deepcopy
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Protocol

from .artifacts import build_artifact_preview, persist_run, persist_run_snapshot
from .prompts import (
    SYSTEM_PROMPT,
    candidate_synthesis_prompt,
    dedupe_merge_prompt,
    task_synthesis_prompt,
)
from .quality import consolidate_candidates, evaluate_portfolio, reconcile_candidate_contracts
from .input_validation import ordinary_tool_output_assets, validate_inputs


STAGE_ORDER = (
    "input_validation",
    "task_synthesis",
    "candidate_synthesis",
    "dedupe_merge",
    "quality_gate",
)


class JsonModel(Protocol):
    def complete_json(self, *, system: str, user: str) -> Any: ...


class PipelineError(RuntimeError):
    def __init__(self, stage: str, message: str) -> None:
        super().__init__(f"{stage}: {message}")
        self.stage = stage


def _object(stage: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PipelineError(stage, "model output must be a JSON object")
    return value


def _array(stage: str, value: Any, key: str) -> list[dict[str, Any]]:
    items = value.get(key)
    if not isinstance(items, list) or not items:
        raise PipelineError(stage, f"model output must contain non-empty {key}")
    if not all(isinstance(item, dict) for item in items):
        raise PipelineError(stage, f"every {key} entry must be an object")
    return items


def _task_output_keys(task: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    for output in task.get("outputs") or []:
        if not isinstance(output, dict):
            continue
        raw = output.get("dedupe_key") or output.get("name") or output.get("display_name")
        key = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "_", str(raw or "").lower()).strip("_")
        if key:
            keys.add(key)
    return keys


TASK_DEDUPE_THRESHOLDS = {
    "inputs": 0.65,
    "outputs": 0.65,
    "description": 0.65,
}

TASK_INPUT_ORIGINS = {
    "user_input": ("user_provided", "request_user"),
    "ordinary_tool_output": ("tool_generated", "ordinary_tool"),
    "upstream_artifact": ("existing_artifact", "provided"),
    "prior_output": ("prior_task_output", "prior_task"),
}
TASK_VALUE_TYPES = {"object", "array", "string", "number", "boolean"}
USER_FACING_ABSTRACT_TERMS = ("映射", "矩阵构建", "假设", "提取", "模式分析", "方向模式", "建模", "聚类", "框架设计", "优先级计算")


def _profile_specific_literals(profile: Any) -> set[str]:
    text = profile if isinstance(profile, str) else json.dumps(profile, ensure_ascii=False)
    english_tokens = re.findall(r"\b[A-Za-z][A-Za-z0-9.+#-]{1,}\b", text)
    literals = {
        token for token in english_tokens
        if any(character.isupper() for character in token)
        or token.lower() in {"python", "pytorch", "tensorflow", "java", "javascript", "typescript", "golang", "rust"}
    }
    for match in re.finditer(r"(?:地点|城市)[^。；\n]{0,16}?(?:考虑|包括|偏好|优先)[：:]?([^，。；\n]+)", text):
        literals.update(item.strip() for item in re.split(r"、|和|及|/", match.group(1)) if len(item.strip()) >= 2)
    for match in re.finditer(r"一名([^，。；\n]{2,24}?)(?:硕士|本科|博士)", text):
        literals.add(match.group(1).strip())
    if any(marker.lower() in text.lower() for marker in ("计算机", "Python", "PyTorch", "人工智能", "软件开发")):
        literals.update({"技术", "技术岗", "技术岗位", "技术方向", "算法", "软件", "开发", "technical"})
    return {item for item in literals if item}


def _semantic_terms(value: str) -> set[str]:
    normalized = str(value or "").lower().replace("_", " ").replace("-", " ")
    ascii_terms = set(re.findall(r"[a-z0-9]+", normalized))
    han = "".join(re.findall(r"[\u4e00-\u9fff]", normalized))
    han_terms = {han[index : index + 2] for index in range(max(0, len(han) - 1))}
    if len(han) == 1:
        han_terms.add(han)
    return ascii_terms | han_terms


def _semantic_text_similarity(left: str, right: str) -> float:
    left_normalized = re.sub(r"\s+", "", str(left or "").lower())
    right_normalized = re.sub(r"\s+", "", str(right or "").lower())
    if not left_normalized or not right_normalized:
        return 0.0
    if left_normalized == right_normalized:
        return 1.0
    left_terms = _semantic_terms(left)
    right_terms = _semantic_terms(right)
    jaccard = (
        len(left_terms & right_terms) / len(left_terms | right_terms)
        if left_terms and right_terms
        else 0.0
    )
    sequence = SequenceMatcher(None, left_normalized, right_normalized).ratio()
    return max(jaccard, sequence)


def _task_field_text(task: dict[str, Any], field: str) -> str:
    values: list[str] = []
    for item in task.get(field) or []:
        if not isinstance(item, dict):
            continue
        keys = (
            ("name", "description", "type", "input_origin", "source_ref", "from_task")
            if field == "inputs"
            else ("name", "display_name", "description", "type", "output_origin", "dedupe_key")
        )
        values.append(" ".join(str(item.get(key) or "") for key in keys))
    return " ".join(values)


def _task_semantic_similarity(left: dict[str, Any], right: dict[str, Any]) -> dict[str, float]:
    left_output_keys = _task_output_keys(left)
    right_output_keys = _task_output_keys(right)
    output_similarity = _semantic_text_similarity(
        _task_field_text(left, "outputs"),
        _task_field_text(right, "outputs"),
    )
    if left_output_keys & right_output_keys:
        output_similarity = 1.0

    left_description = " ".join(
        str(left.get(key) or "") for key in ("name", "business_goal", "description")
    )
    right_description = " ".join(
        str(right.get(key) or "") for key in ("name", "business_goal", "description")
    )
    return {
        "inputs": _semantic_text_similarity(
            _task_field_text(left, "inputs"),
            _task_field_text(right, "inputs"),
        ),
        "outputs": output_similarity,
        "description": _semantic_text_similarity(left_description, right_description),
    }


def _is_semantic_task_duplicate(scores: dict[str, float]) -> bool:
    return all(scores[field] >= threshold for field, threshold in TASK_DEDUPE_THRESHOLDS.items())


def build_task_io_pools(tasks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    input_pool: list[dict[str, Any]] = []
    output_pool: list[dict[str, Any]] = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("task_id") or "")
        task_name = str(task.get("name") or task_id)
        iteration = int(task.get("iteration") or 1)
        for index, raw_input in enumerate(task.get("inputs") or [], start=1):
            if not isinstance(raw_input, dict):
                continue
            name = str(raw_input.get("name") or f"input_{index}")
            input_pool.append({
                **deepcopy(raw_input),
                "pool_id": f"{task_id}:input:{name}:{index}",
                "consumer_task_id": task_id,
                "task_name": task_name,
                "iteration": iteration,
                "semantic_key": re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "_", name.lower()).strip("_"),
            })
        for index, raw_output in enumerate(task.get("outputs") or [], start=1):
            if not isinstance(raw_output, dict):
                continue
            name = str(raw_output.get("name") or f"output_{index}")
            output_pool.append({
                **deepcopy(raw_output),
                "pool_id": f"{task_id}:output:{name}:{index}",
                "producer_task_id": task_id,
                "task_name": task_name,
                "iteration": iteration,
                "semantic_key": str(raw_output.get("dedupe_key") or name),
            })
    return input_pool, output_pool


def _validate_task_io_contract(
    task: dict[str, Any],
    *,
    iteration: int,
    inventory_ids: set[str],
    available_tool_names: set[str],
    available_output_refs: set[str],
    forbidden_user_literals: set[str],
) -> None:
    task_id = str(task.get("task_id") or "unknown_task")
    task_name = str(task.get("name") or "").strip()
    abstract_term = next((term for term in USER_FACING_ABSTRACT_TERMS if term in task_name), None)
    if not task_name or abstract_term:
        raise PipelineError(
            "task_synthesis",
            f"task {task_id} name must be a natural user request and cannot expose abstract term {abstract_term or 'none'}",
        )
    visible_text = json.dumps(task, ensure_ascii=False).lower()
    leaked_literal = next(
        (item for item in sorted(forbidden_user_literals, key=len, reverse=True) if item.lower() in visible_text),
        None,
    )
    if leaked_literal:
        raise PipelineError(
            "task_synthesis",
            f"task {task_id} leaks sample-profile literal {leaked_literal}; parameterize it as invocation input",
        )
    user_requests = task.get("user_request_examples") or []
    if not isinstance(user_requests, list) or not 2 <= len(user_requests) <= 4 or not all(
        isinstance(item, str) and item.strip() for item in user_requests
    ):
        raise PipelineError(
            "task_synthesis",
            f"task {task_id} must include 2-4 non-empty user_request_examples",
        )
    inputs = [item for item in task.get("inputs") or [] if isinstance(item, dict)]
    if not inputs:
        raise PipelineError("task_synthesis", f"task {task_id} must declare at least one typed input")
    for field in inputs:
        name = str(field.get("name") or "unknown_input")
        source = str(field.get("source") or "")
        value_type = str(field.get("type") or "")
        origin = str(field.get("input_origin") or "")
        acquisition = field.get("acquisition") or {}
        mode = str(acquisition.get("mode") or "")
        provider = str(acquisition.get("provider") or "")
        source_ref = str(field.get("source_ref") or "")
        expected = TASK_INPUT_ORIGINS.get(source)
        if value_type not in TASK_VALUE_TYPES:
            raise PipelineError("task_synthesis", f"task {task_id} input {name} has invalid or missing type")
        if expected is None or (origin, mode) != expected:
            raise PipelineError("task_synthesis", f"task {task_id} input {name} has an invalid source/origin/acquisition combination")
        if source == "user_input" and (source_ref or provider):
            raise PipelineError("task_synthesis", f"task {task_id} user input {name} must not name a provider or source_ref")
        if source == "ordinary_tool_output" and provider not in available_tool_names:
            raise PipelineError("task_synthesis", f"task {task_id} input {name} names unknown ordinary tool {provider or 'none'}")
        if source == "upstream_artifact" and source_ref not in inventory_ids:
            raise PipelineError("task_synthesis", f"task {task_id} input {name} references unknown existing artifact {source_ref or 'none'}")
        if source == "prior_output":
            if iteration == 1:
                raise PipelineError("task_synthesis", f"task {task_id} cannot use prior task output in iteration 1")
            if source_ref not in available_output_refs:
                raise PipelineError("task_synthesis", f"task {task_id} input {name} references unknown prior task output {source_ref or 'none'}")

    outputs = [item for item in task.get("outputs") or [] if isinstance(item, dict)]
    if not outputs:
        raise PipelineError("task_synthesis", f"task {task_id} must declare at least one typed output")
    for field in outputs:
        name = str(field.get("name") or "unknown_output")
        if str(field.get("type") or "") not in TASK_VALUE_TYPES:
            raise PipelineError("task_synthesis", f"task {task_id} output {name} has invalid or missing type")
        if field.get("output_origin") != "task_generated":
            raise PipelineError("task_synthesis", f"task {task_id} output {name} must use output_origin task_generated")


def _validate_task_evolution_contract(
    task: dict[str, Any],
    *,
    direction: str,
    retained_tasks: list[dict[str, Any]],
    output_pool: list[dict[str, Any]],
) -> None:
    task_id = str(task.get("task_id") or "unknown_task")
    if task.get("evolution_direction") != direction:
        raise PipelineError("task_synthesis", f"task {task_id} must use evolution_direction {direction}")
    source_ids = [str(item) for item in task.get("source_task_ids") or [] if item]
    known_ids = {str(item.get("task_id")) for item in retained_tasks if item.get("task_id")}
    unknown = sorted(set(source_ids) - known_ids)
    if unknown:
        raise PipelineError("task_synthesis", f"task {task_id} references unknown source_task_ids {unknown}")
    if direction in {"initialization", "discovery"} and source_ids:
        raise PipelineError("task_synthesis", f"{direction} task {task_id} must keep source_task_ids empty")
    if direction == "decomposition":
        if len(source_ids) != 1:
            raise PipelineError("task_synthesis", f"decomposition task {task_id} must name exactly one parent task")
        if str(task.get("task_id")) in source_ids:
            raise PipelineError("task_synthesis", f"decomposition task {task_id} cannot decompose itself")
    if direction == "extension":
        user_facing_text = " ".join(
            str(value or "")
            for value in (
                task.get("name"),
                task.get("business_goal"),
                *(task.get("user_request_examples") or []),
            )
        )
        unnatural_terms = (
            "可验证",
            "验证闭环",
            "假设验证",
            "证据闭环",
            "证据链",
            "置信度评估",
            "评估矩阵",
            "决策框架",
            "归因分析",
            "决策备忘录",
        )
        found_terms = [term for term in unnatural_terms if term in user_facing_text]
        if found_terms:
            raise PipelineError(
                "task_synthesis",
                f"extension task {task_id} uses analyst language {found_terms}; rewrite it as a natural conversational next request",
            )
        if not source_ids:
            raise PipelineError("task_synthesis", f"extension task {task_id} must name at least one source task")
        producer_by_ref: dict[str, str] = {}
        for item in output_pool:
            producer = str(item.get("producer_task_id") or "")
            for value in (item.get("pool_id"), item.get("semantic_key"), item.get("dedupe_key"), item.get("name")):
                if value and producer:
                    producer_by_ref[str(value)] = producer
        prior_inputs = [item for item in task.get("inputs") or [] if isinstance(item, dict) and item.get("source") == "prior_output"]
        consumed_producers = {producer_by_ref.get(str(item.get("source_ref") or "")) for item in prior_inputs}
        consumed_producers.discard(None)
        if not consumed_producers:
            raise PipelineError("task_synthesis", f"extension task {task_id} must consume at least one prior task output")
        if not consumed_producers.issubset(set(source_ids)):
            raise PipelineError("task_synthesis", f"extension task {task_id} source_task_ids must include every consumed output producer")


def _validate_decomposition_replacements(
    tasks: list[dict[str, Any]],
    *,
    retained_tasks: list[dict[str, Any]],
    output_pool: list[dict[str, Any]],
) -> set[str]:
    if not tasks:
        return set()
    children_by_parent: dict[str, list[str]] = {}
    for task in tasks:
        parent_id = str((task.get("source_task_ids") or [""])[0])
        children_by_parent.setdefault(parent_id, []).append(str(task.get("task_id") or ""))
    undersized = {parent: children for parent, children in children_by_parent.items() if len(children) < 2}
    if undersized:
        raise PipelineError(
            "task_synthesis",
            f"each decomposed parent must be replaced by at least two child tasks: {undersized}",
        )

    producer_by_ref: dict[str, str] = {}
    for output in output_pool:
        producer = str(output.get("producer_task_id") or "")
        for value in (output.get("pool_id"), output.get("semantic_key"), output.get("dedupe_key"), output.get("name")):
            if value and producer:
                producer_by_ref[str(value)] = producer
    consumers_by_parent: dict[str, set[str]] = {parent: set() for parent in children_by_parent}
    for task in retained_tasks:
        consumer = str(task.get("task_id") or "")
        for field in task.get("inputs") or []:
            if not isinstance(field, dict) or field.get("source") != "prior_output":
                continue
            producer = producer_by_ref.get(str(field.get("source_ref") or ""))
            if producer in consumers_by_parent and consumer != producer:
                consumers_by_parent[producer].add(consumer)
    blocked = {parent: sorted(consumers) for parent, consumers in consumers_by_parent.items() if consumers}
    if blocked:
        raise PipelineError(
            "task_synthesis",
            f"cannot decompose parents whose outputs are consumed by retained tasks: {blocked}",
        )
    return set(children_by_parent)


def _validate_initialization_coverage(
    tasks: list[dict[str, Any]], coverage: Any
) -> None:
    if not 8 <= len(tasks) <= 10:
        raise PipelineError(
            "task_synthesis",
            f"initialization must return 8-10 realistic tasks, received {len(tasks)}",
        )
    coverage_items = [item for item in coverage or [] if isinstance(item, dict)]
    distinct_outcomes = {
        str(item.get("required_output") or "").strip()
        for item in coverage_items
        if str(item.get("required_output") or "").strip()
    }
    if len(distinct_outcomes) < 8:
        raise PipelineError(
            "task_synthesis",
            f"initialization coverage must declare at least 8 distinct scenario outcomes, received {len(distinct_outcomes)}",
        )
    task_ids = {str(task.get("task_id") or "") for task in tasks}
    covered_ids = {
        str(task_id)
        for item in coverage_items
        for task_id in item.get("covered_by") or []
    }
    missing = sorted(task_ids - covered_ids)
    unknown = sorted(covered_ids - task_ids)
    if missing or unknown:
        raise PipelineError(
            "task_synthesis",
            f"initialization coverage must reference every and only proposed task ID; missing={missing}, unknown={unknown}",
        )


def _dedupe_task_batch(
    retained: list[dict[str, Any]], batch: list[dict[str, Any]], iteration: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    accepted: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []
    known_ids = {str(item.get("task_id")) for item in retained}
    for task in batch:
        task_id = str(task.get("task_id") or "")
        output_keys = _task_output_keys(task)
        if not task_id or not output_keys:
            decisions.append({"task_id": task_id or None, "action": "drop", "reason": "任务缺少稳定 ID 或预测输出"})
            continue
        if task_id in known_ids:
            decisions.append({
                "task_id": task_id,
                "action": "drop",
                "duplicate_of": task_id,
                "reason": "任务 ID 与已保留任务重复",
                "dedupe_method": "exact_task_id",
            })
            continue

        duplicate: dict[str, Any] | None = None
        duplicate_scores: dict[str, float] | None = None
        for existing in retained + accepted:
            scores = _task_semantic_similarity(existing, task)
            if _is_semantic_task_duplicate(scores):
                duplicate = existing
                duplicate_scores = scores
                break
        if duplicate is not None and duplicate_scores is not None:
            decisions.append({
                "task_id": task_id,
                "action": "drop",
                "duplicate_of": str(duplicate.get("task_id")),
                "reason": "输入、预测产物和任务描述的语义均与已保留任务相近",
                "dedupe_method": "semantic_input_output_description",
                "similarity": {key: round(value, 3) for key, value in duplicate_scores.items()},
                "thresholds": TASK_DEDUPE_THRESHOLDS,
            })
            continue
        normalized = dict(task)
        normalized["iteration"] = iteration
        normalized["output_hypotheses"] = sorted(output_keys)
        accepted.append(normalized)
        known_ids.add(task_id)
        decisions.append({
            "task_id": task_id,
            "action": "keep",
            "reason": "未同时满足输入、预测产物和任务描述的语义去重阈值",
            "dedupe_method": "semantic_input_output_description",
        })
    return accepted, decisions


def dedupe_task_pool(task_map: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Re-run deterministic semantic deduplication over an existing task pool."""
    updated = deepcopy(task_map)
    original_tasks = [item for item in updated.get("tasks") or [] if isinstance(item, dict)]
    retained: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []

    for task in original_tasks:
        task_id = str(task.get("task_id") or "")
        if not task_id or not _task_output_keys(task):
            retained.append(task)
            decisions.append({
                "task_id": task_id or None,
                "action": "skip",
                "reason": "任务缺少稳定 ID 或预测输出，保留并跳过语义去重",
                "dedupe_method": "semantic_input_output_description",
            })
            continue
        accepted, batch_decisions = _dedupe_task_batch(
            retained,
            [task],
            int(task.get("iteration") or 1),
        )
        retained.extend(accepted)
        decisions.extend(batch_decisions)

    retained_ids = {str(item.get("task_id")) for item in retained if item.get("task_id")}
    removed_ids = [
        str(item.get("task_id"))
        for item in decisions
        if item.get("action") == "drop" and item.get("task_id")
    ]
    updated["tasks"] = retained
    updated["input_pool"], updated["output_pool"] = build_task_io_pools(retained)
    updated["inferred_outputs"] = deepcopy(updated["output_pool"])
    updated["coverage"] = [
        {**item, "covered_by": [task_id for task_id in item.get("covered_by") or [] if str(task_id) in retained_ids]}
        for item in updated.get("coverage") or []
        if isinstance(item, dict)
        and any(str(task_id) in retained_ids for task_id in item.get("covered_by") or [])
    ]
    audited_decisions = [{**item, "operation": "task_pool_dedupe"} for item in decisions]
    updated["task_dedupe_decisions"] = list(updated.get("task_dedupe_decisions") or []) + audited_decisions
    report = {
        "before_count": len(original_tasks),
        "after_count": len(retained),
        "removed_count": len(removed_ids),
        "removed_task_ids": removed_ids,
        "thresholds": TASK_DEDUPE_THRESHOLDS,
        "decisions": audited_decisions,
    }
    updated["task_pool_dedupe_history"] = list(updated.get("task_pool_dedupe_history") or []) + [report]
    return updated, report


def dedupe_task_pool_iteration(task_map: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run semantic deduplication and record it as a standalone task iteration."""
    before_map = deepcopy(task_map)
    updated, report = dedupe_task_pool(task_map)
    prior_iterations = [
        int(item.get("iteration") or 0)
        for item in updated.get("iterations") or []
        if isinstance(item, dict)
    ]
    iteration = max(prior_iterations, default=0) + 1
    retained_ids = [item.get("task_id") for item in updated.get("tasks") or []]
    removed_ids = set(report.get("removed_task_ids") or [])
    updated.setdefault("iteration_checkpoints", []).append({
        "iteration": iteration,
        "direction": "deduplication",
        "status": "completed",
        "proposed_tasks": deepcopy(before_map.get("tasks") or []),
        "accepted_tasks": deepcopy(updated.get("tasks") or []),
        "removed_tasks": [
            deepcopy(item)
            for item in before_map.get("tasks") or []
            if str(item.get("task_id")) in removed_ids
        ],
        "retained_tasks": deepcopy(updated.get("tasks") or []),
        "input_pool": deepcopy(updated.get("input_pool") or []),
        "output_pool": deepcopy(updated.get("output_pool") or []),
        "coverage": deepcopy(updated.get("coverage") or []),
        "dedupe_decisions": deepcopy(report.get("decisions") or []),
        "iteration_control": {"continue": False, "reason": "独立语义去重迭代已完成"},
        "iteration_limit_reached": False,
        "model_trace": {
            "operation": "deterministic_semantic_task_deduplication",
            "parsed_output": report,
        },
    })
    updated.setdefault("iterations", []).append({
        "iteration": iteration,
        "direction": "deduplication",
        "proposed_task_ids": [item.get("task_id") for item in before_map.get("tasks") or []],
        "retained_task_ids": retained_ids,
        "removed_task_ids": sorted(removed_ids),
        "inferred_outputs": deepcopy(updated.get("output_pool") or []),
        "continue_requested": False,
        "continue_reason": "独立语义去重迭代已完成",
    })
    return updated, report


def _prior_output_contract_name(source_ref: Any, output_pool: list[dict[str, Any]]) -> str:
    reference = str(source_ref or "")
    for output in output_pool:
        aliases = {
            str(value)
            for value in (output.get("pool_id"), output.get("semantic_key"), output.get("dedupe_key"), output.get("name"))
            if value
        }
        if reference in aliases:
            return str(output.get("name") or output.get("semantic_key") or reference)
    return reference


def _normalize_candidate_to_task_contract(
    candidate: dict[str, Any],
    task: dict[str, Any],
    *,
    output_pool: list[dict[str, Any]],
    all_tasks: list[dict[str, Any]],
    skill_task_ids: set[str],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Make the final task pool authoritative for a candidate's public I/O contract."""
    normalized = deepcopy(candidate)
    task_id = str(task.get("task_id") or "")
    changes: list[dict[str, Any]] = []
    if normalized.get("task_ids") != [task_id]:
        changes.append({"action": "task_ids_aligned", "from": normalized.get("task_ids"), "to": [task_id]})
    normalized["task_ids"] = [task_id]

    source_map = {
        "user_input": "user_input",
        "ordinary_tool_output": "ordinary_tool_output",
        "upstream_artifact": "upstream_artifact",
        "prior_output": "prior_skill_output",
    }
    input_schema: dict[str, Any] = {}
    for field in task.get("inputs") or []:
        if not isinstance(field, dict):
            continue
        name = str(field.get("name") or "")
        if not name:
            continue
        task_source = str(field.get("source") or "")
        source = source_map.get(task_source, "invocation_input")
        source_ref = field.get("source_ref")
        acquisition = deepcopy(field.get("acquisition") or {})
        if source == "prior_skill_output":
            producer_task_id = next(
                (
                    str(output.get("producer_task_id") or "")
                    for output in output_pool
                    if str(source_ref or "") in {
                        str(value)
                        for value in (output.get("pool_id"), output.get("semantic_key"), output.get("dedupe_key"), output.get("name"))
                        if value
                    }
                ),
                str(field.get("from_task") or acquisition.get("provider") or ""),
            )
            source_ref = _prior_output_contract_name(source_ref, output_pool)
            if producer_task_id in skill_task_ids:
                acquisition = {
                    "mode": "prior_skill",
                    "provider": producer_task_id,
                    "fallback": acquisition.get("fallback"),
                }
            else:
                source = "invocation_input"
                source_ref = None
                acquisition = {"mode": "provided", "provider": None, "fallback": acquisition.get("fallback")}
        elif source == "user_input":
            source_ref = None
            acquisition = {"mode": "request_user", "provider": None, "fallback": acquisition.get("fallback")}
        else:
            acquisition.setdefault("fallback", None)
        input_schema[name] = {
            "type": field.get("type") or "object",
            "required": field.get("required") is not False,
            "description": field.get("description") or name,
            "source": source,
            "source_ref": source_ref,
            "available": False if source == "user_input" else bool(field.get("available", True)),
            "acquisition": acquisition,
        }
    if normalized.get("input_schema") != input_schema:
        changes.append({"action": "input_schema_aligned", "task_id": task_id})
    normalized["input_schema"] = input_schema

    output_schema = {
        str(field.get("name")): {
            "type": field.get("type") or "object",
            "description": field.get("description") or field.get("display_name") or field.get("name"),
        }
        for field in task.get("outputs") or []
        if isinstance(field, dict) and field.get("name")
    }
    if normalized.get("output_schema") != output_schema:
        changes.append({"action": "output_schema_aligned", "task_id": task_id})
    normalized["output_schema"] = output_schema

    has_required_prior = any(
        field.get("source") == "prior_skill_output" and field.get("required")
        for field in input_schema.values()
    )
    invocation_mode = "aggregate" if has_required_prior else "standalone"
    if normalized.get("invocation_mode") != invocation_mode:
        changes.append({"action": "invocation_mode_aligned", "from": normalized.get("invocation_mode"), "to": invocation_mode})
    normalized["invocation_mode"] = invocation_mode
    normalized["composition"] = {
        "required_prior_outputs": [
            name for name, field in input_schema.items()
            if field.get("source") == "prior_skill_output" and field.get("required")
        ],
        "optional_prior_outputs": [
            name for name, field in input_schema.items()
            if field.get("source") == "prior_skill_output" and not field.get("required")
        ],
    }
    task_output_aliases = {
        str(value)
        for output in output_pool
        if str(output.get("producer_task_id") or "") == task_id
        for value in (output.get("pool_id"), output.get("semantic_key"), output.get("dedupe_key"), output.get("name"))
        if value
    }
    consumers = [
        str(other.get("task_id"))
        for other in all_tasks
        if str(other.get("task_id") or "") in skill_task_ids
        and any(
            isinstance(field, dict)
            and field.get("source") == "prior_output"
            and str(field.get("source_ref") or "") in task_output_aliases
            for field in other.get("inputs") or []
        )
    ]
    if any((field or {}).get("final_consumer") in {"user", "decision"} for field in task.get("outputs") or []):
        consumers.append("user_decision")
    normalized["output_consumers"] = list(dict.fromkeys(consumers or ["user_decision"]))
    return normalized, changes


def _compact_candidate_batch_trace(trace: dict[str, Any]) -> dict[str, Any]:
    exchange = trace.get("model_exchange") or {}
    parsed = trace.get("parsed_output") or {}
    candidates = parsed.get("candidates") or [] if isinstance(parsed, dict) else []
    repair = exchange.get("json_repair") or {}
    return {
        "stage": trace.get("stage"),
        "status": trace.get("status"),
        "duration_ms": trace.get("duration_ms", 0),
        "batch_task_ids": list(trace.get("batch_task_ids") or []),
        "model_exchange": {
            "endpoint": exchange.get("endpoint"),
            "finish_reason": exchange.get("finish_reason"),
            "json_repair_applied": bool(repair),
            "json_repair_finish_reason": repair.get("finish_reason") if isinstance(repair, dict) else None,
        },
        "parsed_output": {
            "candidate_ids": [
                item.get("skill_id") for item in candidates if isinstance(item, dict)
            ]
        },
    }


class SynthesisPipeline:
    def __init__(
        self,
        model: JsonModel,
        *,
        runs_root: Path | None = None,
        tool_catalog: dict[str, Any] | None = None,
        skilltool_template: dict[str, Any] | None = None,
        task_iteration_limit: int = 4,
        task_iteration_start: int = 1,
        task_iteration_directions: tuple[str, ...] | None = None,
    ) -> None:
        if task_iteration_limit < 1:
            raise ValueError("task_iteration_limit must be positive")
        if not 1 <= task_iteration_start <= task_iteration_limit:
            raise ValueError("task_iteration_start must be between 1 and task_iteration_limit")
        if task_iteration_directions is not None and len(task_iteration_directions) not in {
            task_iteration_limit,
            task_iteration_limit - task_iteration_start + 1,
        }:
            raise ValueError("task_iteration_directions must cover the absolute run or the requested iteration window")
        self.model = model
        self.runs_root = runs_root
        self.task_iteration_limit = task_iteration_limit
        self.task_iteration_start = task_iteration_start
        self.task_iteration_directions = task_iteration_directions
        data_root = Path(__file__).resolve().parents[1] / "data"
        self.tool_catalog = tool_catalog or json.loads(
            (data_root / "tools/project_tools.json").read_text(encoding="utf-8")
        )
        self.skilltool_template = skilltool_template or json.loads(
            (data_root / "templates/skilltool_template.json").read_text(encoding="utf-8")
        )

    def _stage(self, name: str, prompt: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        started = time.perf_counter()
        stage_limits = {
            "task_synthesis": 48000,
            "candidate_synthesis": 48000,
            "dedupe_merge": 6000,
        }
        if name.startswith("candidate_synthesis_batch_"):
            limit_key = "candidate_synthesis"
        elif name.startswith("task_synthesis_iteration_"):
            limit_key = "task_synthesis"
        else:
            limit_key = name
        previous_override = getattr(self.model, "max_tokens_override", None)
        configured_max = int(getattr(getattr(self.model, "config", None), "max_tokens", stage_limits.get(limit_key, 12000)))
        if hasattr(self.model, "max_tokens_override"):
            self.model.max_tokens_override = min(configured_max, stage_limits.get(limit_key, configured_max))
        try:
            output = _object(
                name,
                self.model.complete_json(system=SYSTEM_PROMPT, user=prompt),
            )
        except PipelineError:
            raise
        except Exception as error:
            raise PipelineError(name, str(error)) from error
        finally:
            if hasattr(self.model, "max_tokens_override"):
                self.model.max_tokens_override = previous_override
        meta = {
            "stage": name,
            "status": "completed",
            "duration_ms": round((time.perf_counter() - started) * 1000),
        }
        trace = {
            **meta,
            "input": {"system_prompt": SYSTEM_PROMPT, "user_prompt": prompt},
            "model_exchange": getattr(self.model, "last_trace", {}) or {},
            "parsed_output": output,
        }
        return output, meta, trace

    def create_result(
        self,
        *,
        profile: Any,
        scenario: Any,
        model_mode: str,
    ) -> dict[str, Any]:
        if not profile or not scenario:
            raise PipelineError("input", "profile and scenario are required")
        configured_model = getattr(getattr(self.model, "config", None), "model", None)
        model_name = str(configured_model or ("mock" if self.model.__class__.__name__.lower().startswith("mock") else self.model.__class__.__name__))
        model_slug = re.sub(r"[^a-z0-9]+", "-", model_name.lower()).strip("-")[:48] or "unknown-model"
        run_id = f"run-{time.strftime('%Y%m%d-%H%M%S')}-{model_slug}-{uuid.uuid4().hex[:8]}"
        return {
            "run_id": run_id,
            "model_mode": model_mode,
            "model_name": model_name,
            "run_status": "in_progress",
            "next_stage": STAGE_ORDER[0],
            "timing": {
                "started_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "completed_at": None,
                "total_duration_ms": 0,
                "stage_duration_ms": {},
            },
            "inputs": {"profile": profile, "scenario": scenario},
            "skilltool_template": self.skilltool_template,
            "tool_catalog": self.tool_catalog,
            "stages": [],
            "synthesis_trace": [],
            "input_validation": {"passed": False, "status": "pending", "input_inventory": [], "checks": [], "issues": []},
            "task_map": {"input_inventory": [], "input_pool": [], "output_pool": [], "iterations": [], "iteration_checkpoints": [], "tasks": [], "coverage": [], "task_dedupe_decisions": []},
            "candidate_generation": {
                "raw_count": 0,
                "reviewed_count": 0,
                "final_count": 0,
                "raw_candidates": [],
                "dedupe_decisions": [],
                "deterministic_merges": [],
                "portfolio_notes": [],
            },
            "final_candidates": [],
            "quality": {
                "passed": False,
                "status": "pending",
                "rubrics": [],
                "rubric_summary": {"passed": 0, "warnings": 0, "failed": 0, "total": 0},
                "coverage": {"covered_tasks": 0, "total_tasks": 0, "missing_tasks": []},
                "candidate_reports": [],
            },
            "artifacts": [],
            "summary": {"task_iterations": 0, "tasks": 0, "inferred_outputs": 0, "skilltools": 0, "eligible_artifacts": 0, "quality_status": "pending", "failed_rubrics": 0, "warning_rubrics": 0},
        }

    def advance(self, result: dict[str, Any], stage: str) -> dict[str, Any]:
        completed = [item.get("stage") for item in result.get("stages") or []]
        expected = STAGE_ORDER[len(completed)] if len(completed) < len(STAGE_ORDER) else None
        if stage != expected:
            raise PipelineError(stage, f"next required stage is {expected or 'none'}")
        inputs = result["inputs"]
        profile, scenario = inputs["profile"], inputs["scenario"]

        if stage == "input_validation":
            started = time.perf_counter()
            output = validate_inputs(profile, scenario)
            meta = {
                "stage": stage,
                "status": "completed" if output["passed"] else "needs_revision",
                "duration_ms": round((time.perf_counter() - started) * 1000),
            }
            trace = {
                **meta,
                "input": {"profile": profile, "scenario": scenario},
                "operation": "deterministic_input_validation",
                "parsed_output": output,
            }
            result["input_validation"] = output
            result["task_map"]["input_inventory"] = output["input_inventory"]
        elif stage == "task_synthesis":
            started = time.perf_counter()
            seed_map = result.get("task_map") or {} if self.task_iteration_start > 1 else {}
            retained_tasks: list[dict[str, Any]] = deepcopy(seed_map.get("tasks") or [])
            input_pool: list[dict[str, Any]] = deepcopy(seed_map.get("input_pool") or [])
            output_pool: list[dict[str, Any]] = deepcopy(seed_map.get("output_pool") or [])
            if retained_tasks and (not input_pool or not output_pool):
                input_pool, output_pool = build_task_io_pools(retained_tasks)
            inferred_outputs: list[dict[str, Any]] = deepcopy(seed_map.get("inferred_outputs") or output_pool)
            iteration_records: list[dict[str, Any]] = deepcopy(seed_map.get("iterations") or [])
            task_dedupe_decisions: list[dict[str, Any]] = deepcopy(seed_map.get("task_dedupe_decisions") or [])
            iteration_traces: list[dict[str, Any]] = []
            iteration_checkpoints: list[dict[str, Any]] = deepcopy(seed_map.get("iteration_checkpoints") or [])
            coverage: list[dict[str, Any]] = deepcopy(seed_map.get("coverage") or [])
            for iteration in range(self.task_iteration_start, self.task_iteration_limit + 1):
                iteration_direction = (
                    self.task_iteration_directions[
                        iteration - 1
                        if len(self.task_iteration_directions) == self.task_iteration_limit
                        else iteration - self.task_iteration_start
                    ]
                    if self.task_iteration_directions is not None
                    else "discovery"
                )
                base_iteration_prompt = task_synthesis_prompt(
                        profile,
                        scenario,
                        result["input_validation"],
                        iteration=iteration,
                        retained_tasks=retained_tasks,
                        input_pool=input_pool,
                        output_pool=output_pool,
                        available_outputs=inferred_outputs,
                        tool_catalog=self.tool_catalog,
                        iteration_direction=iteration_direction,
                )
                inventory_ids = {
                    str(item.get("asset_id"))
                    for item in result["input_validation"].get("input_inventory") or []
                    if isinstance(item, dict) and item.get("asset_id") and item.get("source") == "upstream_artifact"
                }
                available_tool_names = {
                    str(item.get("name"))
                    for item in self.tool_catalog.get("tools") or []
                    if isinstance(item, dict)
                    and item.get("name")
                    and item.get("selectable_for_skilltool") is True
                    and item.get("implementation_status") != "missing"
                }
                available_output_refs = {
                    str(value)
                    for item in output_pool
                    for value in (item.get("pool_id"), item.get("semantic_key"), item.get("dedupe_key"), item.get("name"))
                    if value
                }
                forbidden_user_literals = _profile_specific_literals(profile)
                attempt_traces: list[dict[str, Any]] = []
                attempt_prompt = base_iteration_prompt
                for attempt in range(1, 4):
                    iteration_output, _, iteration_trace = self._stage(
                        f"task_synthesis_iteration_{iteration}" if attempt == 1 else f"task_synthesis_iteration_{iteration}_correction",
                        attempt_prompt,
                    )
                    attempt_traces.append(iteration_trace)
                    proposed = iteration_output.get("tasks")
                    try:
                        if not isinstance(proposed, list) or not all(isinstance(item, dict) for item in proposed):
                            raise PipelineError(stage, "each iteration must return a tasks array")
                        proposed_ids = [str(item.get("task_id") or "") for item in proposed]
                        if any(not task_id for task_id in proposed_ids) or len(set(proposed_ids)) != len(proposed_ids):
                            raise PipelineError(stage, "each generated task must have a unique non-empty task_id")
                        if iteration_direction == "initialization":
                            _validate_initialization_coverage(
                                proposed,
                                iteration_output.get("coverage"),
                            )
                        existing_ids = {str(item.get("task_id")) for item in retained_tasks if item.get("task_id")}
                        collisions = sorted(set(proposed_ids) & existing_ids)
                        if collisions:
                            raise PipelineError(stage, f"generated task IDs already exist in the pool: {collisions}")
                        for task in proposed:
                            _validate_task_io_contract(
                                task,
                                iteration=iteration,
                                inventory_ids=inventory_ids,
                                available_tool_names=available_tool_names,
                                available_output_refs=available_output_refs,
                                forbidden_user_literals=forbidden_user_literals,
                            )
                            if self.task_iteration_directions is not None:
                                _validate_task_evolution_contract(
                                    task,
                                    direction=iteration_direction,
                                    retained_tasks=retained_tasks,
                                    output_pool=output_pool,
                                )
                        if iteration_direction == "decomposition":
                            _validate_decomposition_replacements(
                                proposed,
                                retained_tasks=retained_tasks,
                                output_pool=output_pool,
                            )
                        if iteration == 1:
                            for task in proposed:
                                task_inputs = [item for item in task.get("inputs") or [] if isinstance(item, dict)]
                                if not task_inputs or any(item.get("source") == "prior_output" for item in task_inputs) or task.get("dependencies"):
                                    raise PipelineError(stage, "first-iteration tasks cannot depend on prior task outputs or other tasks")
                        break
                    except PipelineError as contract_error:
                        if attempt == 3:
                            raise
                        attempt_prompt = f"""{base_iteration_prompt}

CORRECTION REQUIRED
The previous JSON failed the deterministic task contract with this error:
{contract_error}

Previous JSON:
{json.dumps(iteration_output, ensure_ascii=False)}

Regenerate the complete top-level JSON. Fix the reported error and re-check every task against all source rules and the USER-EXPRESSIBILITY GATE. Do not explain the correction; return JSON only."""
                iteration_trace["attempts"] = deepcopy(attempt_traces)
                accepted = []
                for task in proposed:
                    normalized = dict(task)
                    normalized["iteration"] = iteration
                    normalized["output_hypotheses"] = sorted(_task_output_keys(task))
                    accepted.append(normalized)
                decisions: list[dict[str, Any]] = []
                removed_tasks: list[dict[str, Any]] = []
                removed_ids: set[str] = set()
                if iteration_direction == "decomposition" and accepted:
                    removed_ids = {
                        str(parent_id)
                        for task in accepted
                        for parent_id in task.get("source_task_ids") or []
                    }
                    removed_tasks = [
                        deepcopy(task)
                        for task in retained_tasks
                        if str(task.get("task_id")) in removed_ids
                    ]
                    retained_tasks = [
                        task
                        for task in retained_tasks
                        if str(task.get("task_id")) not in removed_ids
                    ]
                    coverage = [
                        {
                            **item,
                            "covered_by": [
                                task_id
                                for task_id in item.get("covered_by") or []
                                if str(task_id) not in removed_ids
                            ],
                        }
                        for item in coverage
                        if isinstance(item, dict)
                        and any(str(task_id) not in removed_ids for task_id in item.get("covered_by") or [])
                    ]
                retained_tasks.extend(accepted)
                input_pool, output_pool = build_task_io_pools(retained_tasks)
                _, new_outputs = build_task_io_pools(accepted)
                inferred_outputs = deepcopy(output_pool)
                kept_ids = {str(item.get("task_id")) for item in accepted}
                coverage.extend(
                    item for item in iteration_output.get("coverage") or []
                    if isinstance(item, dict) and kept_ids & set(map(str, item.get("covered_by") or []))
                )
                control = iteration_output.get("iteration_control") or {}
                iteration_records.append({
                    "iteration": iteration,
                    "direction": iteration_direction,
                    "proposed_task_ids": [item.get("task_id") for item in proposed],
                    "retained_task_ids": [item.get("task_id") for item in accepted],
                    "removed_task_ids": sorted(removed_ids),
                    "inferred_outputs": new_outputs,
                    "continue_requested": bool(control.get("continue")),
                    "continue_reason": control.get("reason"),
                })
                iteration_trace["iteration"] = iteration
                iteration_trace["generation_acceptance"] = {
                    "accepted_task_ids": [item.get("task_id") for item in accepted],
                    "semantic_dedupe_applied": False,
                }
                iteration_traces.append(iteration_trace)
                checkpoint = {
                    "iteration": iteration,
                    "direction": iteration_direction,
                    "status": "completed",
                    "proposed_tasks": deepcopy(proposed),
                    "accepted_tasks": deepcopy(accepted),
                    "removed_tasks": deepcopy(removed_tasks),
                    "retained_tasks": deepcopy(retained_tasks),
                    "input_pool": deepcopy(input_pool),
                    "output_pool": deepcopy(output_pool),
                    "coverage": deepcopy(coverage),
                    "dedupe_decisions": [],
                    "iteration_control": deepcopy(control),
                    "iteration_limit_reached": iteration == self.task_iteration_limit,
                    "model_trace": deepcopy(iteration_trace),
                }
                iteration_checkpoints.append(checkpoint)
                # Publish and persist a complete per-round snapshot immediately. If a
                # later model call fails, all successful rounds remain inspectable.
                result["task_map"] = {
                    "input_inventory": result["input_validation"]["input_inventory"],
                    "input_pool": deepcopy(input_pool),
                    "output_pool": deepcopy(output_pool),
                    "iterations": deepcopy(iteration_records),
                    "iteration_checkpoints": deepcopy(iteration_checkpoints),
                    "tasks": deepcopy(retained_tasks),
                    "coverage": deepcopy(coverage),
                    "inferred_outputs": deepcopy(inferred_outputs),
                    "task_dedupe_decisions": deepcopy(task_dedupe_decisions),
                }
                result["summary"]["task_iterations"] = len(iteration_records)
                result["summary"]["tasks"] = len(retained_tasks)
                result["summary"]["inferred_outputs"] = len(inferred_outputs)
                if self.runs_root is not None and result.get("run_directory"):
                    persist_run_snapshot(self.runs_root, result["run_id"], result)
                if self.task_iteration_directions is None and (not accepted or not bool(control.get("continue"))):
                    break
            if not retained_tasks:
                raise PipelineError(stage, "iterative task synthesis did not retain any task with an inferred output")
            output = {
                "input_inventory": result["input_validation"]["input_inventory"],
                "input_pool": input_pool,
                "output_pool": output_pool,
                "iterations": iteration_records,
                "iteration_checkpoints": iteration_checkpoints,
                "tasks": retained_tasks,
                "coverage": coverage,
                "inferred_outputs": inferred_outputs,
                "task_dedupe_decisions": task_dedupe_decisions,
            }
            meta = {
                "stage": stage,
                "status": "completed",
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "iteration_count": len(iteration_records),
            }
            trace = {**meta, "input": {"profile": profile, "scenario": scenario}, "model_iterations": iteration_traces, "parsed_output": output}
            additional_assets = ordinary_tool_output_assets(
                output["tasks"], result["input_validation"]["input_inventory"]
            )
            revalidated = validate_inputs(profile, scenario, additional_assets)
            revalidated["validation_pass"] = "post_task_reconciliation"
            revalidated["additional_assets"] = [item["asset_id"] for item in additional_assets]
            result["input_validation"] = revalidated
            if result.get("synthesis_trace") and result["synthesis_trace"][0].get("stage") == "input_validation":
                result["synthesis_trace"][0]["parsed_output"] = revalidated
                result["synthesis_trace"][0]["operation"] = "deterministic_input_validation_with_task_reconciliation"
            output["input_inventory"] = revalidated["input_inventory"]
            output["input_reconciliation"] = {
                "status": revalidated["status"],
                "additional_assets": revalidated["additional_assets"],
            }
            result["task_map"] = output
            result["summary"]["task_iterations"] = len(iteration_records)
            result["summary"]["tasks"] = len(output.get("tasks") or [])
            result["summary"]["inferred_outputs"] = len(inferred_outputs)
        elif stage == "candidate_synthesis":
            skill_tasks = [
                item for item in result["task_map"].get("tasks") or []
                if item.get("synthesis_decision") == "skilltool"
            ]
            batch_size = 1
            generation = result["candidate_generation"]
            raw_candidates: list[dict[str, Any]] = list(generation.get("raw_candidates") or [])
            batch_traces: list[dict[str, Any]] = [
                _compact_candidate_batch_trace(item)
                for item in result.get("candidate_batch_traces") or []
            ]
            task_contract_reconciliations: list[dict[str, Any]] = list(
                generation.get("task_contract_reconciliations") or []
            )
            completed_task_ids = {
                str(task_id)
                for candidate in raw_candidates
                for task_id in candidate.get("task_ids") or []
            }
            compact_profile = profile if isinstance(profile, str) else {
                "available_sections": list(profile),
                "profile_boundaries": profile.get("profile_boundaries") or {},
                "note": "Candidate design may reference these sections as supplied evidence, but must not embed this user's personal values into reusable runtime instructions.",
            }
            started = time.perf_counter()
            for offset in range(0, len(skill_tasks), batch_size):
                batch_tasks = skill_tasks[offset : offset + batch_size]
                batch_ids = {str(item.get("task_id")) for item in batch_tasks}
                if batch_ids.issubset(completed_task_ids):
                    continue
                batch_map = {
                    **result["task_map"],
                    "tasks": batch_tasks,
                    "coverage": [
                        item for item in result["task_map"].get("coverage") or []
                        if batch_ids & set(map(str, item.get("covered_by") or []))
                    ],
                }
                need_ids = {
                    str(need_id)
                    for task in batch_tasks
                    for need_id in task.get("need_ids") or []
                }
                batch_task_context = {
                    "task_output_hypotheses": [
                        item for item in result["task_map"].get("inferred_outputs") or []
                        if str(item.get("producer_task_id")) in batch_ids
                    ],
                }
                batch_scenario = scenario if isinstance(scenario, str) else {
                    "scenario_id": scenario.get("scenario_id"),
                    "name": scenario.get("name"),
                    "objective": scenario.get("objective"),
                    "target_domain": scenario.get("target_domain") or {},
                    "scope": scenario.get("scope") or {},
                    "quality_preferences": scenario.get("quality_preferences") or {},
                    "composition_preferences": scenario.get("composition_preferences") or {},
                    "note": "Only the requested task is in scope; other scenario outputs must not be synthesized in this call.",
                }
                batch_name = f"candidate_synthesis_batch_{offset // batch_size + 1}"
                batch_output, _, batch_trace = self._stage(
                    batch_name,
                    candidate_synthesis_prompt(
                        compact_profile,
                        batch_scenario,
                        batch_task_context,
                        batch_map,
                        self.tool_catalog,
                        self.skilltool_template,
                    ),
                )
                batch_candidates = _array(batch_name, batch_output, "candidates")
                accepted_candidates: list[dict[str, Any]] = []
                for candidate in batch_candidates:
                    covered = set(map(str, candidate.get("task_ids") or []))
                    if covered != batch_ids:
                        continue
                    task = batch_tasks[0]
                    normalized_candidate, contract_changes = _normalize_candidate_to_task_contract(
                        candidate,
                        task,
                        output_pool=result["task_map"].get("output_pool") or [],
                        all_tasks=result["task_map"].get("tasks") or [],
                        skill_task_ids={str(item.get("task_id")) for item in skill_tasks},
                    )
                    task_iteration = int(task.get("iteration") or 1)
                    candidate_inputs = normalized_candidate.get("input_schema") or {}
                    required_sources = {
                        str((field or {}).get("source") or "")
                        for field in candidate_inputs.values()
                        if (field or {}).get("required")
                    }
                    if task_iteration == 1 and required_sources & {"profile", "scenario", "prior_skill_output"}:
                        raise PipelineError(batch_name, "a first-iteration SkillTool may use user input, ordinary-tool output, or existing scenario artifacts, but not prior task outputs")
                    accepted_candidates.append(normalized_candidate)
                    task_contract_reconciliations.extend(
                        {"skill_id": normalized_candidate.get("skill_id"), **change}
                        for change in contract_changes
                    )
                if len(accepted_candidates) != len(batch_tasks):
                    raise PipelineError(batch_name, "model must return exactly one candidate for each requested task")
                for candidate in accepted_candidates:
                    raw_candidates.append(candidate)
                    completed_task_ids.update(map(str, candidate.get("task_ids") or []))
                batch_trace["batch_task_ids"] = sorted(batch_ids)
                batch_traces.append(_compact_candidate_batch_trace(batch_trace))
                if not batch_ids.issubset(completed_task_ids):
                    raise PipelineError(batch_name, "model candidates did not cover the requested task IDs")
                generation["raw_candidates"] = raw_candidates
                generation["raw_count"] = len(raw_candidates)
                generation["task_contract_reconciliations"] = task_contract_reconciliations
                result["candidate_batch_traces"] = batch_traces
                if self.runs_root is not None and result.get("run_directory"):
                    persist_run_snapshot(self.runs_root, result["run_id"], result)
            output = {"candidates": raw_candidates}
            meta = {
                "stage": stage,
                "status": "completed",
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "batch_count": len(batch_traces),
            }
            trace = {
                **meta,
                "input": {"batch_task_ids": [item["batch_task_ids"] for item in batch_traces]},
                "model_batches": batch_traces,
                "parsed_output": output,
            }
            if not raw_candidates:
                raise PipelineError(stage, "batched model output did not contain candidates for the requested tasks")
            result["candidate_generation"]["raw_candidates"] = raw_candidates
            result["candidate_generation"]["raw_count"] = len(raw_candidates)
            result.pop("candidate_batch_traces", None)
        elif stage == "dedupe_merge":
            candidate_output = {"candidates": result["candidate_generation"]["raw_candidates"]}
            output, meta, trace = self._stage(
                stage, dedupe_merge_prompt(candidate_output, result["task_map"])
            )
            reviewed = candidate_output["candidates"]
            reconciled, contract_reconciliations = reconcile_candidate_contracts(
                reviewed,
                input_inventory=result["task_map"].get("input_inventory") or [],
            )
            consolidated, deterministic_merges = consolidate_candidates(reconciled)
            result["final_candidates"] = consolidated
            generation = result["candidate_generation"]
            generation["reviewed_count"] = len(reviewed)
            generation["final_count"] = len(consolidated)
            generation["dedupe_decisions"] = output.get("decisions") or []
            generation["deterministic_merges"] = deterministic_merges
            generation["contract_reconciliations"] = contract_reconciliations
            generation["portfolio_notes"] = output.get("portfolio_notes") or []
            generation["model_kept_candidate_ids"] = output.get("kept_candidate_ids") or []
            result["summary"]["skilltools"] = len(consolidated)
        else:
            started = time.perf_counter()
            quality = evaluate_portfolio(
                result["final_candidates"],
                result["task_map"],
                tool_catalog=self.tool_catalog,
                scenario=scenario,
            )
            meta = {
                "stage": stage,
                "status": "completed" if quality["passed"] else "needs_revision",
                "duration_ms": round((time.perf_counter() - started) * 1000),
            }
            trace = {
                **meta,
                "input": {
                    "candidates": result["final_candidates"],
                    "task_map": result["task_map"],
                    "scenario": scenario,
                    "tool_catalog": self.tool_catalog,
                },
                "operation": "deterministic_quality_gate",
                "parsed_output": quality,
            }
            result["quality"] = quality
            report_by_skill = {item["skill_id"]: item for item in quality["candidate_reports"]}
            eligible = [
                item for item in result["final_candidates"]
                if report_by_skill.get(item.get("skill_id"), {}).get("passed")
            ]
            result["artifacts"] = [build_artifact_preview(item) for item in eligible]
            result["summary"]["eligible_artifacts"] = len(result["artifacts"])
            result["summary"]["quality_status"] = quality["status"]
            result["summary"]["failed_rubrics"] = quality["rubric_summary"]["failed"]
            result["summary"]["warning_rubrics"] = quality["rubric_summary"]["warnings"]

        result["stages"].append(meta)
        result["synthesis_trace"].append(trace)
        timing = result.setdefault("timing", {})
        stage_durations = timing.setdefault("stage_duration_ms", {})
        stage_durations[stage] = meta.get("duration_ms", 0)
        timing["total_duration_ms"] = sum(
            int(value or 0) for value in stage_durations.values()
        )
        completed_count = len(result["stages"])
        result["next_stage"] = STAGE_ORDER[completed_count] if completed_count < len(STAGE_ORDER) else None
        result["run_status"] = "completed" if result["next_stage"] is None else "in_progress"
        return result

    def run(
        self,
        *,
        profile: Any,
        scenario: Any,
        persist: bool = True,
        model_mode: str = "api",
        progress_callback: Any | None = None,
    ) -> dict[str, Any]:
        result = self.create_result(
            profile=profile, scenario=scenario, model_mode=model_mode
        )
        if persist:
            if self.runs_root is None:
                raise PipelineError("persist", "runs_root is not configured")
            result["run_directory"] = str(self.runs_root / result["run_id"])
            persist_run(self.runs_root, result["run_id"], result)
        for stage in STAGE_ORDER:
            if progress_callback:
                progress_callback(stage, "started")
            try:
                self.advance(result, stage)
            except Exception as error:
                result["run_status"] = "failed"
                result["error"] = {"stage": getattr(error, "stage", stage), "message": str(error)}
                result["synthesis_trace"].append({
                    "stage": stage,
                    "status": "failed",
                    "model_exchange": getattr(self.model, "last_trace", {}) or {},
                    "error": str(error),
                })
                if persist and self.runs_root is not None:
                    persist_run_snapshot(self.runs_root, result["run_id"], result)
                if progress_callback:
                    progress_callback(stage, "failed")
                raise
            if persist and self.runs_root is not None:
                persist_run_snapshot(self.runs_root, result["run_id"], result)
            if progress_callback:
                progress_callback(stage, "completed")
        return result

    def resume(
        self,
        result: dict[str, Any],
        *,
        persist: bool = True,
        progress_callback: Any | None = None,
    ) -> dict[str, Any]:
        """Continue a persisted failed or interrupted run from its next stage."""

        completed = len(result.get("stages") or [])
        if completed >= len(STAGE_ORDER):
            return result
        result["synthesis_trace"] = [
            item for item in result.get("synthesis_trace") or []
            if item.get("status") != "failed"
        ]
        result.pop("error", None)
        result["run_status"] = "in_progress"
        result["next_stage"] = STAGE_ORDER[completed]
        if persist:
            if self.runs_root is None:
                raise PipelineError("persist", "runs_root is not configured")
            result["run_directory"] = str(self.runs_root / result["run_id"])
            persist_run_snapshot(self.runs_root, result["run_id"], result)
        for stage in STAGE_ORDER[completed:]:
            if progress_callback:
                progress_callback(stage, "started")
            try:
                self.advance(result, stage)
            except Exception as error:
                result["run_status"] = "failed"
                result["error"] = {"stage": getattr(error, "stage", stage), "message": str(error)}
                result["synthesis_trace"].append({
                    "stage": stage,
                    "status": "failed",
                    "model_exchange": getattr(self.model, "last_trace", {}) or {},
                    "error": str(error),
                })
                if persist and self.runs_root is not None:
                    persist_run_snapshot(self.runs_root, result["run_id"], result)
                if progress_callback:
                    progress_callback(stage, "failed")
                raise
            if persist and self.runs_root is not None:
                persist_run_snapshot(self.runs_root, result["run_id"], result)
            if progress_callback:
                progress_callback(stage, "completed")
        return result

    def recheck_quality(self, result: dict[str, Any], *, persist: bool = True) -> dict[str, Any]:
        """Re-run deterministic contract reconciliation, consolidation, and quality."""

        generation = result["candidate_generation"]
        raw_candidates = list(generation.get("raw_candidates") or result.get("final_candidates") or [])
        dedupe_trace = next(
            (item for item in reversed(result.get("synthesis_trace") or []) if item.get("stage") == "dedupe_merge"),
            {},
        )
        dedupe_output = dedupe_trace.get("parsed_output") or {}
        kept_ids = {str(item) for item in dedupe_output.get("kept_candidate_ids") or []}
        reviewed = [item for item in raw_candidates if not kept_ids or str(item.get("skill_id")) in kept_ids]
        reconciled, contract_reconciliations = reconcile_candidate_contracts(
            reviewed,
            input_inventory=result["task_map"].get("input_inventory") or [],
        )
        consolidated, deterministic_merges = consolidate_candidates(reconciled)
        result["final_candidates"] = consolidated
        generation["reviewed_count"] = len(reviewed)
        generation["final_count"] = len(consolidated)
        generation["deterministic_merges"] = deterministic_merges
        generation["contract_reconciliations"] = contract_reconciliations
        result["summary"]["skilltools"] = len(consolidated)
        quality = evaluate_portfolio(
            consolidated,
            result["task_map"],
            tool_catalog=self.tool_catalog,
            scenario=result["inputs"]["scenario"],
        )
        result["quality"] = quality
        report_by_skill = {item["skill_id"]: item for item in quality["candidate_reports"]}
        eligible = [
            item for item in consolidated
            if report_by_skill.get(item.get("skill_id"), {}).get("passed")
        ]
        result["artifacts"] = [build_artifact_preview(item) for item in eligible]
        result["summary"]["eligible_artifacts"] = len(result["artifacts"])
        result["summary"]["quality_status"] = quality["status"]
        result["summary"]["failed_rubrics"] = quality["rubric_summary"]["failed"]
        result["summary"]["warning_rubrics"] = quality["rubric_summary"]["warnings"]
        result["postprocessing_recheck"] = {
            "completed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "contract_reconciliations": len(contract_reconciliations),
            "quality_status": quality["status"],
        }
        if persist:
            if self.runs_root is None:
                raise PipelineError("persist", "runs_root is not configured")
            persist_run_snapshot(self.runs_root, result["run_id"], result)
        return result
