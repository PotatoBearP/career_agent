from __future__ import annotations

import argparse

from cli_common import add_common_arguments, execute, print_result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run exactly one object-relation pipeline stage.")
    add_common_arguments(parser)
    parser.add_argument("--stage", required=True, help="Full stage name or prefix such as stage2_2.")
    args = parser.parse_args()
    state = execute(args, from_stage=args.stage, to_stage=args.stage)
    print_result(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

