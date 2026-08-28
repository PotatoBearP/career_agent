from __future__ import annotations

import random
from typing import Any

from .contracts import StageContext, StageExecution


STAGE_NAME = "stage3_1_relation_sampling"


def _input_options(item: dict[str, Any]) -> list[str]:
    options = list(item.get("acquisition_options") or [])
    if int((item.get("role_statistics") or {}).get("output") or 0) > 0:
        options.append("prior_skill_output")
    return list(dict.fromkeys(options))


def _weighted_choice(rng: random.Random, values: list[dict[str, Any]], weights: list[float]) -> dict[str, Any]:
    return rng.choices(values, weights=weights, k=1)[0]


def run(context: StageContext) -> StageExecution:
    object_set = context.state.get("object_set") or {}
    objects = list(object_set.get("canonical_objects") or [])
    if len(objects) < 2:
        raise ValueError("at least two canonical objects are required for relation sampling")
    sampling = dict((context.state.get("options") or {}).get("sampling") or {})
    seed = int(sampling.get("seed", 20260827))
    target_count = max(1, int(sampling.get("target_count", 8)))
    multiplier = max(1, int(sampling.get("candidate_multiplier", 3)))
    candidate_goal = target_count * multiplier
    mode = str(sampling.get("mode") or "constrained")
    if mode not in {"random", "constrained"}:
        raise ValueError("sampling mode must be random or constrained")
    k_min = max(1, int(sampling.get("k_min", 1)))
    k_max = min(len(objects) - 1, max(k_min, int(sampling.get("k_max", 3))))
    if k_min > k_max:
        raise ValueError("k range is incompatible with the Object Set size")
    rng = random.Random(seed)
    signatures: set[str] = set()
    sampled: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    attempts = 0
    max_attempts = max(candidate_goal * 50, 200)

    input_eligible = [item for item in objects if _input_options(item)]
    if len(input_eligible) < k_min:
        raise ValueError("Object Set does not contain enough acquirable input objects")

    while len(sampled) < candidate_goal and attempts < max_attempts:
        attempts += 1
        if mode == "random":
            output = rng.choice(objects)
        else:
            output = _weighted_choice(
                rng,
                objects,
                [1.0 + 2.0 * int(int((item.get("role_statistics") or {}).get("output") or 0) > 0) for item in objects],
            )
        k = rng.randint(k_min, min(k_max, len(input_eligible)))
        candidates = [item for item in input_eligible if item["object_id"] != output["object_id"]]
        if len(candidates) < k:
            rejected.append({"attempt": attempts, "reason": "insufficient_distinct_inputs", "output_object_id": output["object_id"]})
            continue
        if mode == "random":
            selected_inputs = rng.sample(candidates, k)
        else:
            pool = list(candidates)
            selected_inputs = []
            while pool and len(selected_inputs) < k:
                selected = _weighted_choice(
                    rng,
                    pool,
                    [
                        1.0
                        + 1.5 * int("user_input" in _input_options(item) or "existing_artifact" in _input_options(item))
                        + 0.5 * min(4, len(item.get("provenance") or []))
                        for item in pool
                    ],
                )
                selected_inputs.append(selected)
                pool = [item for item in pool if item["object_id"] != selected["object_id"]]
        input_ids = sorted(item["object_id"] for item in selected_inputs)
        signature = "+".join(input_ids) + "->" + output["object_id"]
        if signature in signatures:
            rejected.append({"attempt": attempts, "reason": "duplicate_relation_signature", "signature": signature})
            continue
        signatures.add(signature)
        sampled.append({
            "relation_id": f"sample_relation_{len(sampled) + 1:03d}",
            "input_object_ids": input_ids,
            "output_object_id": output["object_id"],
            "k": len(input_ids),
            "sampling_mode": mode,
            "seed": seed,
            "relation_signature": signature,
            "input_acquisition_options": {
                item["object_id"]: _input_options(item)
                for item in selected_inputs
            },
            "sampling_evidence": {
                "output_prior_roles": output.get("role_statistics") or {},
                "input_provenance_counts": {
                    item["object_id"]: len(item.get("provenance") or [])
                    for item in selected_inputs
                },
            },
        })
    if not sampled:
        raise ValueError("relation sampler could not produce any k-to-1 relation")
    config = {
        "seed": seed,
        "mode": mode,
        "target_count": target_count,
        "candidate_multiplier": multiplier,
        "candidate_goal": candidate_goal,
        "k_min": k_min,
        "k_max": k_max,
        "attempts": attempts,
        "max_attempts": max_attempts,
    }
    return StageExecution(
        input_payload={"canonical_objects": objects, "sampling_config": config},
        output={"sampling_config": config, "sampled_relations": sampled, "sampling_rejections": rejected},
        state_updates={
            "sampling_config": config,
            "sampled_relations": sampled,
            "sampling_rejections": rejected,
            "summary": {**context.state.get("summary", {}), "sampled_relations": len(sampled)},
        },
        trace={
            "operation": "seeded_k_to_one_relation_sampling",
            "deterministic": True,
            "seed": seed,
            "attempts": attempts,
        },
        files={
            "sampling-config.json": config,
            "sampled-relations.json": sampled,
            "sampling-rejections.json": rejected,
        },
    )

