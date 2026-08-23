from __future__ import annotations

import re
from copy import deepcopy
from typing import Any


VALID_SOURCES = {
    "profile",
    "scenario",
    "upstream_artifact",
    "user_input",
    "ordinary_tool_output",
    "external_data",
}
VALID_AVAILABILITY = {"available", "acquirable", "conditional", "missing"}


def _natural_language_upstream_artifacts(scenario: str) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for match in re.finditer(r"已有产物\s*`([a-zA-Z][a-zA-Z0-9_-]*)`", scenario):
        asset_id = match.group(1)
        nearby = scenario[match.end() : match.end() + 80]
        type_match = re.search(r"\b(object|array|string|number|boolean)\b", nearby)
        artifacts.append({
            "asset_id": asset_id,
            "name": "用户画像" if asset_id == "user_profile" else asset_id,
            "type": type_match.group(1) if type_match else "object",
            "source": "upstream_artifact",
            "availability": "available",
            "producer": {"kind": "previous_scenario", "name": "previous_scenario", "stage": "upstream"},
            "derived_from": [],
            "description": f"自然语言场景声明的已有产物 {asset_id}",
        })
    return artifacts


def validate_inputs(
    profile: Any,
    scenario: Any,
    additional_assets: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    upstream = (
        (scenario.get("upstream_stage") or {}).get("artifacts") or []
        if isinstance(scenario, dict)
        else _natural_language_upstream_artifacts(scenario) if isinstance(scenario, str) else []
    )
    # Old structured scenarios may contain objects bound to the former input
    # schema. New runs represent profile and scenario directly as text assets.
    upstream = [item for item in upstream if isinstance(item, dict) and not item.get("bound_input")]
    inventory = [deepcopy(item) for item in upstream if isinstance(item, dict)]
    inventory.extend(deepcopy(item) for item in (additional_assets or []) if isinstance(item, dict))
    bound_inputs = {str(item.get("bound_input")) for item in inventory if item.get("bound_input")}
    initial_inputs = {
        "profile": (profile, "用户画像输入", "用户画像、能力证据、偏好与约束"),
        "scenario": (scenario, "业务场景定义", "本轮合成的业务目标、范围、约束与必需输出"),
    }
    for source, (value, name, description) in initial_inputs.items():
        if source in bound_inputs:
            continue
        inventory.append(
            {
                "asset_id": f"{source}_input",
                "name": name,
                "type": "string" if isinstance(value, str) else "object",
                "source": source,
                "availability": "available" if value else "missing",
                "producer": {"kind": "initial_input", "name": source, "stage": "run_input"},
                "derived_from": [],
                "description": description,
                "bound_input": source,
            }
        )

    issues: list[dict[str, Any]] = []
    ids = [str(item.get("asset_id") or "") for item in inventory]
    known_ids = {item for item in ids if item}
    duplicates = sorted({item for item in ids if item and ids.count(item) > 1})
    if duplicates:
        issues.append({"code": "duplicate_input_asset_id", "severity": "error", "assets": duplicates, "message": "输入资产 ID 重复"})

    for index, asset in enumerate(inventory):
        asset_id = str(asset.get("asset_id") or f"input_{index + 1}")
        missing_contract = [key for key in ("asset_id", "name", "type", "source", "availability", "producer") if not asset.get(key)]
        if missing_contract:
            issues.append({"code": "input_contract_incomplete", "severity": "error", "asset_id": asset_id, "fields": missing_contract, "message": f"输入资产 {asset_id} 缺少契约字段"})
        if not str(asset.get("description") or "").strip():
            issues.append({"code": "input_description_missing", "severity": "error", "asset_id": asset_id, "message": f"输入资产 {asset_id} 缺少 description"})
        if asset.get("source") not in VALID_SOURCES:
            issues.append({"code": "input_source_invalid", "severity": "error", "asset_id": asset_id, "message": f"输入资产 {asset_id} 的来源不合法"})
        if asset.get("availability") not in VALID_AVAILABILITY:
            issues.append({"code": "input_availability_invalid", "severity": "error", "asset_id": asset_id, "message": f"输入资产 {asset_id} 的可用状态不合法"})
        unknown_derivations = [item for item in asset.get("derived_from") or [] if item not in known_ids]
        if unknown_derivations:
            issues.append({"code": "input_derivation_unknown", "severity": "error", "asset_id": asset_id, "references": unknown_derivations, "message": f"输入资产 {asset_id} 引用了不存在的派生来源"})
        bound_input = str(asset.get("bound_input") or "")
        if bound_input:
            value = {"profile": profile, "scenario": scenario}.get(bound_input)
            if value is None:
                issues.append({"code": "input_binding_invalid", "severity": "error", "asset_id": asset_id, "message": f"输入资产 {asset_id} 的 bound_input 不合法"})
            elif asset.get("availability") == "available" and not value:
                issues.append({"code": "input_bound_value_missing", "severity": "error", "asset_id": asset_id, "message": f"输入资产 {asset_id} 声明可用但绑定值为空"})
        producer = asset.get("producer") or {}
        if asset.get("availability") in {"acquirable", "conditional"} and not producer.get("name"):
            issues.append({"code": "input_acquisition_provider_missing", "severity": "error", "asset_id": asset_id, "message": f"输入资产 {asset_id} 缺少获取提供者"})

    checks = []
    definitions = (
        ("contract_complete", "输入契约完整", {"input_contract_incomplete", "duplicate_input_asset_id"}),
        ("description_complete", "输入解释完整", {"input_description_missing"}),
        ("source_valid", "输入来源合法", {"input_source_invalid", "input_binding_invalid"}),
        ("availability_truthful", "可用状态可信", {"input_availability_invalid", "input_bound_value_missing"}),
        ("derivation_valid", "派生关系有效", {"input_derivation_unknown"}),
        ("acquisition_ready", "缺失输入可获取", {"input_acquisition_provider_missing"}),
    )
    for check_id, label, codes in definitions:
        matched = [item for item in issues if item.get("code") in codes]
        checks.append({
            "check_id": check_id,
            "label": label,
            "status": "fail" if matched else "pass",
            "summary": "符合要求" if not matched else "；".join(str(item.get("message")) for item in matched),
            "issues": matched,
        })
    passed = not any(item["status"] == "fail" for item in checks)
    return {
        "passed": passed,
        "status": "passed" if passed else "needs_revision",
        "input_inventory": inventory,
        "checks": checks,
        "issues": issues,
        "summary": {
            "total": len(inventory),
            "available": sum(item.get("availability") == "available" for item in inventory),
            "acquirable": sum(item.get("availability") in {"acquirable", "conditional"} for item in inventory),
            "missing": sum(item.get("availability") == "missing" for item in inventory),
        },
    }


def ordinary_tool_output_assets(
    tasks: list[dict[str, Any]],
    existing_inventory: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    existing = {str(item.get("asset_id")) for item in existing_inventory if item.get("asset_id")}
    assets: list[dict[str, Any]] = []
    for task in tasks:
        if task.get("synthesis_decision") != "ordinary_tool":
            continue
        derived_from = sorted({
            str(item.get("source_ref"))
            for item in task.get("inputs") or []
            if isinstance(item, dict) and item.get("source_ref")
        })
        provider = str(task.get("execution_provider") or task.get("name") or task.get("task_id") or "ordinary_tool")
        for output in task.get("outputs") or []:
            if not isinstance(output, dict):
                continue
            asset_id = str(output.get("name") or "")
            if not asset_id or asset_id in existing:
                continue
            assets.append({
                "asset_id": asset_id,
                "name": str(output.get("display_name") or output.get("name") or asset_id),
                "type": str(output.get("type") or "object"),
                "source": "ordinary_tool_output",
                "availability": "acquirable",
                "producer": {"kind": "ordinary_tool", "name": provider, "stage": "task_synthesis"},
                "derived_from": derived_from,
                "description": str(output.get("description") or f"{task.get('name') or task.get('task_id')}产生的结构化结果：{task.get('business_goal') or asset_id}"),
            })
            existing.add(asset_id)
    return assets
