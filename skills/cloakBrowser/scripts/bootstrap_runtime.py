#!/usr/bin/env python3
from __future__ import annotations

import argparse

from _runtime import ensure_runtime, print_runtime_info_json


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create and maintain the dedicated CloakBrowser runtime for this skill.",
    )
    parser.add_argument(
        "--skip-binary",
        action="store_true",
        help="Install Python packages but skip the cloakbrowser binary download step.",
    )
    parser.add_argument(
        "--info",
        action="store_true",
        help="Print runtime paths and exit without creating or updating the runtime.",
    )
    args = parser.parse_args()

    if args.info:
        print_runtime_info_json()
        return 0

    runtime_python = ensure_runtime(install_binary=not args.skip_binary)
    print(runtime_python)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
