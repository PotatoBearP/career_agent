from __future__ import annotations

import argparse

from cli_common import add_common_arguments, execute, print_result
from object_relation_pipeline.pipeline.contracts import STAGE_ORDER


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a configurable interval of the object-relation Skill pipeline.")
    add_common_arguments(parser)
    parser.add_argument("--from-stage", default=STAGE_ORDER[0], help="Full stage name or prefix such as stage2_1.")
    parser.add_argument("--to-stage", default=STAGE_ORDER[-1], help="Full stage name or prefix such as stage3_3.")
    args = parser.parse_args()
    state = execute(args, from_stage=args.from_stage, to_stage=args.to_stage)
    print_result(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
