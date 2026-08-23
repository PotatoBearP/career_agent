from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.artifacts import persist_run_snapshot
from pipeline.direct_synthesis import finalize_direct_result
from pipeline.model_api import ModelConfig, OpenAICompatibleModel
from pipeline.synthesis import SynthesisPipeline


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _eligible_tasks(result: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        task
        for task in (result.get("task_map") or {}).get("tasks") or []
        if task.get("synthesis_decision") == "skilltool"
    ]


def _validate_direct_artifacts(
    tasks: list[dict[str, Any]], candidates: list[dict[str, Any]]
) -> None:
    expected = {str(task.get("task_id")) for task in tasks}
    covered: list[str] = [
        str(task_id)
        for candidate in candidates
        for task_id in candidate.get("task_ids") or []
    ]
    if set(covered) != expected or len(covered) != len(expected):
        raise RuntimeError(
            "direct synthesis must cover every eligible task exactly once; "
            f"expected={sorted(expected)}, covered={sorted(covered)}"
        )
    for candidate in candidates:
        if not candidate.get("skill_name") or not candidate.get("tool_name"):
            raise RuntimeError("every direct candidate needs skill_name and tool_name")
        if not (candidate.get("operating_model") or {}).get("workflow"):
            raise RuntimeError(
                f"candidate {candidate.get('skill_id')} has no executable workflow"
            )
        declared = set(candidate.get("child_tools") or [])
        selected = {
            str(item.get("tool_name"))
            for item in candidate.get("tool_selection") or []
            if isinstance(item, dict) and item.get("tool_name")
        }
        if declared != selected:
            raise RuntimeError(
                f"candidate {candidate.get('skill_id')} child_tools do not match tool_selection"
            )


def _pascal(value: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", value.replace("_", " ").replace("-", " "))
    return "".join(word[:1].upper() + word[1:] for word in words) or "GeneratedAction"


def _task_inputs(task: dict[str, Any]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for item in task.get("inputs") or []:
        description = str(item.get("description") or item.get("name") or "")
        required = not any(marker in description.lower() for marker in ("可选", "optional"))
        origin = str(item.get("input_origin") or item.get("source") or "user_provided")
        source = {
            "user_provided": "user_input",
            "existing_artifact": "upstream_artifact",
            "tool_generated": "ordinary_tool_output",
            "prior_task_output": "prior_skill_output",
        }.get(origin, str(item.get("source") or "invocation_input"))
        acquisition = dict(item.get("acquisition") or {})
        if not acquisition.get("mode"):
            acquisition["mode"] = "request_user" if source == "user_input" else "provided"
        acquisition.setdefault("provider", None)
        acquisition.setdefault("fallback", None)
        fields[str(item.get("name"))] = {
            "type": item.get("type") or "object",
            "required": required,
            "description": description,
            "source": source,
            "source_ref": item.get("source_ref"),
            "available": bool(item.get("available", True)),
            "acquisition": acquisition,
        }
    return fields


def _task_outputs(task: dict[str, Any]) -> dict[str, Any]:
    return {
        str(item.get("name")): {
            "type": item.get("type") or "object",
            "description": item.get("description") or item.get("display_name") or item.get("name"),
        }
        for item in task.get("outputs") or []
    }


def _select_tools(task: dict[str, Any]) -> list[dict[str, Any]]:
    # The final task contract is authoritative. Do not add browsing merely because
    # a task discusses jobs; supplied role descriptions and opportunity lists are
    # sufficient unless the task explicitly declares that current data is required.
    if not bool(task.get("fresh_data_required")):
        return []
    return [
        {
            "tool_name": "WebSearch",
            "usage_mode": "required",
            "reason": "检索与目标岗位或机会相关的当前公开证据。",
            "condition": None,
            "fallback": None,
        },
        {
            "tool_name": "WebFetch",
            "usage_mode": "conditional",
            "reason": "打开关键来源并核对职位、要求、日期与原始表述。",
            "condition": "搜索摘要不足以支持结论或需要核验机会真实性时。",
            "fallback": "仅保留可由搜索结果直接支持的结论，并明确证据限制。",
        },
    ]


def _offline_candidate(task: dict[str, Any]) -> dict[str, Any]:
    task_id = str(task.get("task_id"))
    base = task_id.removeprefix("task_")
    skill_name = base.replace("_", "-")
    inputs = _task_inputs(task)
    outputs = _task_outputs(task)
    tools = _select_tools(task)
    input_names = list(inputs)
    required_names = [name for name, field in inputs.items() if field.get("required")]
    output_names = list(outputs)
    input_label = "、".join(f"`{name}`" for name in input_names)
    required_label = "、".join(f"`{name}`" for name in required_names)
    output_label = "、".join(f"`{name}`" for name in output_names)
    workflow: list[dict[str, Any]] = [
        {
            "step": 1,
            "name": "校验调用输入",
            "instructions": [
                f"检查全部输入 {input_label} 的类型，并确认必需输入 {required_label} 均可用。",
                "只使用本次调用明确提供或按 source_ref 解析得到的信息，不补造用户事实。",
            ],
            "success_criteria": ["所有必需输入均可解析，缺失项被准确列出。"],
        }
    ]
    if tools:
        workflow.append(
            {
                "step": 2,
                "name": "收集并核验当前证据",
                "instructions": [
                    "使用 `WebSearch` 检索与目标相关的当前公开信息，并记录来源、发布日期和适用范围。",
                    "满足条件时用 `WebFetch` 打开原始页面，区分事实、推断与无法确认的信息。",
                ],
                "success_criteria": ["关键判断均有可追溯来源，过期或冲突证据已标注。"],
            }
        )
    workflow.extend(
        [
            {
                "step": len(workflow) + 1,
                "name": str(task.get("name") or "形成任务结果"),
                "instructions": [
                    f"围绕业务目标“{task.get('business_goal') or task.get('name')}”处理已验证输入。",
                    "先列出证据与约束，再形成结论；每项结论注明依据、不确定性和适用条件。",
                    "排序时优先采用与用户明确目标和约束直接相关、证据更充分的项目。",
                ],
                "success_criteria": [f"形成完整的 {output_label}，且每项内容都能回溯到输入或公开证据。"],
            },
            {
                "step": len(workflow) + 2,
                "name": "验证并返回",
                "instructions": [
                    f"检查输出只包含声明字段 {output_label}，字段类型与 action-tool 契约一致。",
                    "删除重复项，明确限制，并根据结果选择 success、insufficient_input 或 error。",
                ],
                "success_criteria": ["结构完整、无虚构事实、边界与 outcome 一致。"],
            },
        ]
    )
    return {
        "skill_id": base,
        "skill_name": skill_name,
        "tool_name": _pascal(base),
        "title": task.get("name") or _pascal(base),
        "business_goal": task.get("business_goal") or task.get("name") or "",
        "invocation_mode": task.get("invocation_mode") or "standalone",
        "composition": {"required_prior_outputs": [], "optional_prior_outputs": []},
        "when_to_use": (
            f"当用户需要“{task.get('name')}”时使用。"
            "不用于替代缺失的用户输入，也不扩展到未声明的相邻任务。"
        ),
        "reference_pattern": "ref/skills 中的边界、顺序工作流、结果分支与返回前检查模式",
        "task_ids": [task_id],
        "scenario_binding": {
            "domain_source": "scenario_only",
            "domain_mode": "open",
            "explicit_domains": [],
            "profile_role": "evidence_only",
        },
        "scope": {
            "includes": [task.get("business_goal") or task.get("name")],
            "excludes": ["重写用户画像", "执行未声明的相邻职业任务", "把不确定推断表述为事实"],
        },
        "input_schema": inputs,
        "output_schema": outputs,
        "output_consumers": ["user_decision"],
        "tool_selection": tools,
        "child_tools": [item["tool_name"] for item in tools],
        "fresh_data_policy": "required" if tools else "none",
        "action_tool": {
            "search_hint": task.get("business_goal") or task.get("name"),
            "preserve_existing": True,
            "always_load": True,
            "read_only": not bool(tools),
        },
        "operating_model": {
            "role": f"负责{task.get('name')}的职业决策支持代理。",
            "hard_boundaries": [
                "只完成当前 Action Tool 声明的单一任务。",
                "不得虚构用户背景、偏好、约束、岗位事实或来源。",
                "不得调用或发现其他 Skill；生命周期结束只调用一次 ReturnSkillResult。",
            ],
            "workflow": workflow,
            "decision_rules": [
                "用户明确陈述优先于推断；事实证据优先于一般经验。",
                "证据冲突时保留冲突并降低置信度，不强行合并为确定结论。",
                "排序结果必须给出与输入目标、约束和证据的逐项对应理由。",
            ],
            "outcome_rules": {
                "success": ["所有必需输入可用，且声明输出已完整生成并通过结构检查。"],
                "insufficient_input": ["一个或多个必需输入缺失、不可解析或不足以支持任务结论。"],
                "error": ["工具执行失败或最终结果无法序列化为声明契约。"],
            },
            "artifact_contract": {
                "mode": "none",
                "artifact_type": None,
                "file_name_pattern": None,
                "format": None,
                "verification_steps": [],
            },
            "final_checks": [
                "每个必需输入都来自声明的供应路径。",
                "每个结论都可回溯到输入或工具证据。",
                "输出字段名称和类型与契约一致。",
                "未泄漏画像全文，未执行边界外任务，outcome 选择正确。",
            ],
        },
        "complexity": {
            "level": "bounded",
            "estimated_steps": len(workflow),
            "rationale": "直接把单一用户任务、必要输入和最小工具集合组合为可调用能力。",
        },
        "independence": {"portable": True, "assumptions": []},
        "evaluation_cases": [
            {
                "id": f"{base}_success",
                "user_query": (task.get("user_request_examples") or [task.get("name")])[0],
                "available_context": {name: "valid" for name in input_names},
                "expected_outcome": "success",
                "must_include": output_names,
                "must_not_include": ["invented_user_fact"],
            },
            {
                "id": f"{base}_missing_input",
                "user_query": task.get("name") or base,
                "available_context": {},
                "expected_outcome": "insufficient_input",
                "must_include": ["missing_input"],
                "must_not_include": ["fabricated_result"],
            },
            {
                "id": f"{base}_boundary",
                "user_query": f"{task.get('name')}，并顺便执行其他未声明任务",
                "available_context": {name: "valid" for name in input_names},
                "expected_outcome": "success",
                "must_include": output_names,
                "must_not_include": ["out_of_scope_task"],
            },
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Directly combine a saved final task pool with suitable ordinary tools and "
            "render ref-style SkillTool artifacts. No dedupe or quality-gate stages are run."
        )
    )
    parser.add_argument("--run-id", required=True)
    parser.add_argument(
        "--output-run-id",
        help="Write results to a new run ID instead of updating the source run.",
    )
    parser.add_argument(
        "--config",
        default=str(ROOT / "data" / "model_config.local.json"),
        help="OpenAI-compatible model config JSON (default: data/model_config.local.json)",
    )
    parser.add_argument(
        "--use-model",
        action="store_true",
        help="Use the configured external model. Default is a fully local deterministic synthesis.",
    )
    args = parser.parse_args()

    run_path = ROOT / "runs" / args.run_id / "run.json"
    result = _load_json(run_path)
    tasks = _eligible_tasks(result)
    if not tasks:
        raise SystemExit("saved run has no SkillTool tasks")

    if args.output_run_id:
        output_dir = ROOT / "runs" / args.output_run_id
        if output_dir.exists():
            raise SystemExit(f"output run already exists: {args.output_run_id}")
        result["run_id"] = args.output_run_id
        result["run_status"] = "running"
        result["candidate_generation"] = {
            "raw_candidates": [],
            "raw_count": 0,
        }
        result["final_candidates"] = []
        result["artifacts"] = []
        result.pop("direct_synthesis", None)

    if args.use_model:
        # Never treat candidates from a previous local deterministic batch as
        # completed model work when updating the same run.
        if (result.get("candidate_generation") or {}).get("mode") == "local_deterministic_direct":
            result["candidate_generation"] = {"raw_candidates": [], "raw_count": 0}
        config = ModelConfig.from_dict(_load_json(Path(args.config)))
        pipeline = SynthesisPipeline(
            OpenAICompatibleModel(config),
            runs_root=ROOT / "runs",
        )
        # A previous interrupted direct batch can resume from its completed candidates.
        result["next_stage"] = "candidate_synthesis"
        pipeline.advance(result, "candidate_synthesis")
        candidates = list(
            (result.get("candidate_generation") or {}).get("raw_candidates") or []
        )
    else:
        candidates = [_offline_candidate(task) for task in tasks]
        result["candidate_generation"] = {
            "raw_candidates": candidates,
            "raw_count": len(candidates),
            "mode": "local_deterministic_direct",
        }
    _validate_direct_artifacts(tasks, candidates)

    finalize_direct_result(
        result,
        generator="configured_model" if args.use_model else "local_deterministic",
    )
    persist_run_snapshot(ROOT / "runs", result["run_id"], result)

    print(
        json.dumps(
            {
                "run_id": result["run_id"],
                "status": result["run_status"],
                "tasks": len(tasks),
                "skilltools": len(candidates),
                "generated_skills": str(
                    ROOT / "runs" / result["run_id"] / "generated-skills"
                ),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
