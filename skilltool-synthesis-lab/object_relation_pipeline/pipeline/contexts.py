from __future__ import annotations

import hashlib
import re
from itertools import combinations
from typing import Any


def _slug(value: Any, fallback: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")
    return text[:48] or fallback


def _unique_id(prefix: str, requested: Any, content: str, index: int, used: set[str]) -> str:
    base = _slug(requested, f"{prefix}_{index:03d}")
    if not base.startswith(prefix + "_"):
        base = f"{prefix}_{base}"
    candidate = base
    if candidate in used:
        digest = hashlib.sha1(content.encode("utf-8")).hexdigest()[:8]
        candidate = f"{base}_{digest}"
    if candidate in used:
        candidate = f"{base}_{index:03d}"
    used.add(candidate)
    return candidate


def normalize_documents(
    values: list[dict[str, Any] | str] | None,
    *,
    singular: str | None,
    prefix: str,
) -> list[dict[str, Any]]:
    source = list(values or [])
    if not source and str(singular or "").strip():
        source = [{"content": str(singular).strip()}]
    normalized: list[dict[str, Any]] = []
    used: set[str] = set()
    for index, raw in enumerate(source, start=1):
        item = raw if isinstance(raw, dict) else {"content": str(raw)}
        content = str(item.get("content") or "").strip()
        if not content:
            raise ValueError(f"{prefix} {index} content is required")
        identifier = _unique_id(prefix, item.get(f"{prefix}_id") or item.get("id"), content, index, used)
        normalized.append({
            f"{prefix}_id": identifier,
            "name": str(item.get("name") or identifier.replace("_", " ")).strip(),
            "content": content,
            "weight": max(0.01, float(item.get("weight", 1.0))),
            "tags": list(dict.fromkeys(str(tag).strip() for tag in item.get("tags") or [] if str(tag).strip())),
        })
    if not normalized:
        raise ValueError(f"at least one {prefix} is required")
    return normalized


def normalize_context_inputs(
    *,
    profile: str | None = None,
    scenario: str | None = None,
    profiles: list[dict[str, Any] | str] | None = None,
    scenarios: list[dict[str, Any] | str] | None = None,
    bindings: list[dict[str, Any]] | None = None,
    max_bindings: int = 16,
) -> dict[str, Any]:
    normalized_profiles = normalize_documents(profiles, singular=profile, prefix="profile")
    normalized_scenarios = normalize_documents(scenarios, singular=scenario, prefix="scenario")
    profile_ids = {item["profile_id"] for item in normalized_profiles}
    scenario_ids = {item["scenario_id"] for item in normalized_scenarios}
    normalized_bindings = []
    if bindings:
        seen_pairs: set[tuple[str, str]] = set()
        used_binding_ids: set[str] = set()
        for index, raw in enumerate(bindings, start=1):
            profile_id = str(raw.get("profile_id") or "")
            scenario_id = str(raw.get("scenario_id") or "")
            if profile_id not in profile_ids or scenario_id not in scenario_ids:
                raise ValueError(f"binding {index} references an unknown profile or scenario")
            pair = (profile_id, scenario_id)
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            binding_id = _unique_id(
                "binding",
                raw.get("binding_id"),
                f"{profile_id}|{scenario_id}",
                index,
                used_binding_ids,
            )
            normalized_bindings.append({
                "binding_id": binding_id,
                "profile_id": profile_id,
                "scenario_id": scenario_id,
                "weight": max(0.01, float(raw.get("weight", 1.0))),
            })
    else:
        pairs = [
            (profile_item["profile_id"], scenario_item["scenario_id"])
            for profile_item in normalized_profiles
            for scenario_item in normalized_scenarios
        ]
        if len(pairs) > max_bindings:
            raise ValueError(
                f"automatic profile-scenario Cartesian product has {len(pairs)} bindings; "
                f"provide explicit bindings or raise max_bindings={max_bindings}"
            )
        normalized_bindings = [
            {
                "binding_id": f"binding_{index:03d}",
                "profile_id": profile_id,
                "scenario_id": scenario_id,
                "weight": 1.0,
            }
            for index, (profile_id, scenario_id) in enumerate(pairs, start=1)
        ]
    if not normalized_bindings:
        raise ValueError("at least one profile-scenario binding is required")
    if len(normalized_bindings) > max_bindings:
        raise ValueError(f"binding count {len(normalized_bindings)} exceeds max_bindings={max_bindings}")
    return {
        "profiles": normalized_profiles,
        "scenarios": normalized_scenarios,
        "bindings": normalized_bindings,
        "binding_mode": "explicit" if bindings else "auto",
        "profile": normalized_profiles[0]["content"],
        "scenario": normalized_scenarios[0]["content"],
    }


def context_indexes(inputs: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    return (
        {str(item["profile_id"]): item for item in inputs.get("profiles") or []},
        {str(item["scenario_id"]): item for item in inputs.get("scenarios") or []},
    )


def context_pack(
    inputs: dict[str, Any],
    *,
    profile_ids: list[str] | None = None,
    scenario_ids: list[str] | None = None,
) -> dict[str, Any]:
    profile_by_id, scenario_by_id = context_indexes(inputs)
    selected_profiles = profile_ids or list(profile_by_id)
    selected_scenarios = scenario_ids or list(scenario_by_id)
    return {
        "profiles": [profile_by_id[item] for item in selected_profiles if item in profile_by_id],
        "scenarios": [scenario_by_id[item] for item in selected_scenarios if item in scenario_by_id],
    }


def context_text(pack: dict[str, Any]) -> str:
    profile_text = "\n\n".join(
        f"PROFILE {item['profile_id']} ({item.get('name')}):\n{item['content']}"
        for item in pack.get("profiles") or []
    )
    scenario_text = "\n\n".join(
        f"SCENARIO {item['scenario_id']} ({item.get('name')}):\n{item['content']}"
        for item in pack.get("scenarios") or []
    )
    return f"{profile_text}\n\n{scenario_text}".strip()


def scenario_text(pack: dict[str, Any]) -> str:
    return "\n\n".join(
        f"SCENARIO {item['scenario_id']} ({item.get('name')}):\n{item['content']}"
        for item in pack.get("scenarios") or []
    ).strip()


def task_context_pack(state: dict[str, Any], task: dict[str, Any]) -> dict[str, Any]:
    contract = task.get("context_contract") or {}
    return context_pack(
        state["inputs"],
        profile_ids=list(contract.get("profile_ids") or []),
        scenario_ids=list(contract.get("scenario_ids") or []),
    )


def relation_context_pack(state: dict[str, Any], relation: dict[str, Any]) -> dict[str, Any]:
    contract = relation.get("context_contract") or {}
    return context_pack(
        state["inputs"],
        profile_ids=list(contract.get("profile_ids") or []),
        scenario_ids=list(contract.get("scenario_ids") or []),
    )


def default_bridge_candidates(inputs: dict[str, Any]) -> list[dict[str, Any]]:
    scenarios_by_profile: dict[str, list[str]] = {}
    binding_by_pair = {
        (str(item["profile_id"]), str(item["scenario_id"])): str(item["binding_id"])
        for item in inputs.get("bindings") or []
    }
    for binding in inputs.get("bindings") or []:
        scenarios_by_profile.setdefault(str(binding["profile_id"]), []).append(str(binding["scenario_id"]))
    groups = []
    for profile_id, scenario_ids in scenarios_by_profile.items():
        for scenario_pair in combinations(dict.fromkeys(scenario_ids), 2):
            groups.append({
                "bridge_group_id": f"bridge_{len(groups) + 1:03d}",
                "profile_ids": [profile_id],
                "scenario_ids": list(scenario_pair),
                "binding_ids": [binding_by_pair[(profile_id, scenario_id)] for scenario_id in scenario_pair],
            })
    return groups


def contract_for_binding(binding: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": "local",
        "profile_ids": [binding["profile_id"]],
        "scenario_ids": [binding["scenario_id"]],
        "binding_ids": [binding["binding_id"]],
        "scenario_contributions": [],
        "integration_reason": "single profile-scenario binding",
    }
