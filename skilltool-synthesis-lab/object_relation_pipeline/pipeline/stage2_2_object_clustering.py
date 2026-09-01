from __future__ import annotations

import hashlib
import re
from collections import Counter
from copy import deepcopy
from typing import Any

from .contracts import StageContext, StageExecution
from .contexts import context_pack, scenario_text
from .prompts import RELATION_SYSTEM_PROMPT, object_clustering_prompt
from .storage import write_value


STAGE_NAME = "stage2_2_object_clustering"
VALID_TYPES = {"object", "array", "string", "number", "boolean"}


def _snake(value: Any) -> str:
    normalized = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "_", str(value or "").lower()).strip("_")
    return normalized or "information_object"


def _object_id(name: str, value_type: str, member_ids: list[str]) -> str:
    digest = hashlib.sha1((name + "|" + value_type + "|" + "|".join(sorted(member_ids))).encode("utf-8")).hexdigest()[:8]
    return f"obj_{_snake(name)[:38]}_{digest}"


def _project_semantic_role(
    mention_ids: list[str],
    mention_to_object: dict[str, str],
    decision_by_object: dict[str, dict[str, Any]],
) -> tuple[list[str], list[dict[str, Any]]]:
    """Project mentions through LLM semantic clusters without adding a second dedupe heuristic."""
    projected: list[str] = []
    mentions_by_object: dict[str, list[str]] = {}
    for mention_id in mention_ids:
        object_id = mention_to_object[mention_id]
        if object_id not in mentions_by_object:
            projected.append(object_id)
            mentions_by_object[object_id] = []
        mentions_by_object[object_id].append(mention_id)
    collapses = []
    for object_id in projected:
        source_mentions = mentions_by_object[object_id]
        if len(source_mentions) < 2:
            continue
        cluster_decision = decision_by_object[object_id]
        collapses.append({
            "object_id": object_id,
            "source_mention_ids": source_mentions,
            "basis": "shared_llm_semantic_cluster",
            "reason": cluster_decision.get("reason") or "LLM semantic identity decision",
        })
    return projected, collapses


def run(context: StageContext) -> StageExecution:
    mentions = deepcopy(context.state.get("raw_object_mentions") or [])
    relations = deepcopy(context.state.get("latent_relations") or [])
    if not mentions or not relations:
        raise ValueError("relation extraction output is required before clustering")
    scenario = scenario_text(context_pack(context.state["inputs"]))
    prompt = object_clustering_prompt(mentions, scenario)
    stage_dir = context.run_dir / "stages" / STAGE_NAME
    write_value(stage_dir / "clustering-prompt.txt", prompt)
    raw = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=prompt)
    write_value(stage_dir / "model-trace.json", deepcopy(getattr(context.relation_model, "last_trace", {}) or {}))
    write_value(stage_dir / "model-output.json", raw)
    clusters = raw.get("clusters") if isinstance(raw, dict) else None
    if not isinstance(clusters, list):
        raise ValueError("object clustering must return a clusters array")
    mention_by_id = {str(item["mention_id"]): item for item in mentions}
    assigned: set[str] = set()
    normalized_clusters: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []

    for cluster_index, raw_cluster in enumerate(clusters, start=1):
        if not isinstance(raw_cluster, dict):
            continue
        member_ids = [str(item) for item in raw_cluster.get("member_mention_ids") or [] if str(item) in mention_by_id]
        if len(member_ids) != len(set(member_ids)):
            raise ValueError(f"object mention repeated within one cluster: {member_ids}")
        duplicate_assignments = sorted(set(member_ids) & assigned)
        if duplicate_assignments:
            raise ValueError(f"object mentions assigned to multiple clusters: {duplicate_assignments}")
        if not member_ids:
            continue
        members = [mention_by_id[item] for item in member_ids]
        by_type: dict[str, list[dict[str, Any]]] = {}
        for member in members:
            by_type.setdefault(str(member.get("type") or "object"), []).append(member)
        for value_type, typed_members in sorted(by_type.items()):
            if value_type not in VALID_TYPES:
                raise ValueError(f"invalid object type in cluster: {value_type}")
            typed_ids = [item["mention_id"] for item in typed_members]
            name = _snake(raw_cluster.get("canonical_name") or typed_members[0].get("name"))
            if len(by_type) > 1:
                name = f"{name}_{value_type}"
            canonical = {
                "object_id": _object_id(name, value_type, typed_ids),
                "name": name,
                "display_name": str(raw_cluster.get("display_name") or typed_members[0].get("display_name") or name),
                "description": str(raw_cluster.get("description") or typed_members[0].get("description") or name),
                "type": value_type,
                "member_mention_ids": typed_ids,
                "role_statistics": dict(Counter(str(item.get("role")) for item in typed_members)),
                "acquisition_options": list(dict.fromkeys(
                    option
                    for item in typed_members
                    for option in item.get("acquisition_options") or []
                )),
                "provenance": [
                    {
                        "mention_id": item["mention_id"],
                        "task_id": item.get("source_task_id"),
                        "role": item.get("role"),
                    }
                    for item in typed_members
                ],
                "profile_scope": list(dict.fromkeys(value for item in typed_members for value in item.get("profile_scope") or [])),
                "scenario_scope": list(dict.fromkeys(value for item in typed_members for value in item.get("scenario_scope") or [])),
                "binding_ids": list(dict.fromkeys(value for item in typed_members for value in item.get("binding_ids") or [])),
            }
            normalized_clusters.append(canonical)
            assigned.update(typed_ids)
            decisions.append({
                "object_id": canonical["object_id"],
                "member_mention_ids": typed_ids,
                "action": "merge" if len(typed_ids) > 1 else "singleton",
                "reason": raw_cluster.get("merge_reason") or "LLM canonical cluster",
                "type_split_applied": len(by_type) > 1,
            })

    for mention_id, mention in mention_by_id.items():
        if mention_id in assigned:
            continue
        name = _snake(mention.get("name"))
        canonical = {
            "object_id": _object_id(name, str(mention.get("type") or "object"), [mention_id]),
            "name": name,
            "display_name": mention.get("display_name") or name,
            "description": mention.get("description") or name,
            "type": mention.get("type") or "object",
            "member_mention_ids": [mention_id],
            "role_statistics": {str(mention.get("role")): 1},
            "acquisition_options": list(mention.get("acquisition_options") or []),
            "provenance": [{"mention_id": mention_id, "task_id": mention.get("source_task_id"), "role": mention.get("role")}],
            "profile_scope": list(mention.get("profile_scope") or []),
            "scenario_scope": list(mention.get("scenario_scope") or []),
            "binding_ids": list(mention.get("binding_ids") or []),
        }
        normalized_clusters.append(canonical)
        decisions.append({
            "object_id": canonical["object_id"],
            "member_mention_ids": [mention_id],
            "action": "singleton_fallback",
            "reason": "LLM did not assign this mention; retained deterministically.",
            "type_split_applied": False,
        })

    mention_to_object = {
        mention_id: item["object_id"]
        for item in normalized_clusters
        for mention_id in item["member_mention_ids"]
    }
    decision_by_object = {item["object_id"]: item for item in decisions}
    canonical_relations = []
    relation_semantic_projections = []
    for relation in relations:
        input_ids, input_collapses = _project_semantic_role(
            relation["input_mention_ids"], mention_to_object, decision_by_object
        )
        output_ids, output_collapses = _project_semantic_role(
            relation["output_mention_ids"], mention_to_object, decision_by_object
        )
        canonical_relations.append({
            **relation,
            "input_object_ids": input_ids,
            "output_object_ids": output_ids,
            "canonical_label": f"t([{','.join(input_ids)}],[{','.join(output_ids)}])",
        })
        relation_semantic_projections.append({
            "relation_id": relation["relation_id"],
            "input_collapses": input_collapses,
            "output_collapses": output_collapses,
        })
    object_set = {
        "canonical_objects": normalized_clusters,
        "mention_to_object": mention_to_object,
        "cluster_decisions": decisions,
        "p0_canonical_relations": canonical_relations,
        "relation_semantic_projections": relation_semantic_projections,
    }
    model_trace = deepcopy(getattr(context.relation_model, "last_trace", {}) or {})
    return StageExecution(
        input_payload={"raw_object_mentions": mentions, "scenario": scenario},
        output=object_set,
        state_updates={
            "object_set": object_set,
            "summary": {
                **context.state.get("summary", {}),
                "canonical_objects": len(normalized_clusters),
            },
        },
        trace={
            "operation": "llm_assisted_role_agnostic_object_clustering",
            "system_prompt": RELATION_SYSTEM_PROMPT,
            "user_prompt": prompt,
            "model_trace": model_trace,
            "parsed_output": raw,
            "deterministic_postprocessing": decisions,
        },
        files={
            "clustering-prompt.txt": prompt,
            "model-output.json": raw,
            "canonical-objects.json": normalized_clusters,
            "mention-to-object.json": mention_to_object,
            "cluster-decisions.json": decisions,
            "p0-canonical-relations.json": canonical_relations,
            "relation-semantic-projections.json": relation_semantic_projections,
        },
    )
