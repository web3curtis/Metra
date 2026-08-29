"""
Local Critiqor diagnosis bridge (optional).

Requires Critiqor installed or PYTHONPATH pointing at the Critiqor checkout.
Does not alter WebMCP oracle/metrics — prints diagnosis JSON to stdout.

Usage:
  python adapters/critiqor/diagnose_local.py \\
    --run-id <id> \\
    --events path/to/critiqor/events.jsonl \\
    [--session path/to/final-state.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_events(path: Path) -> list[dict]:
    events: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        events.append(json.loads(line))
    return events


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--events", required=True, type=Path)
    parser.add_argument("--session", type=Path, default=None)
    parser.add_argument(
        "--critiqor-root",
        type=Path,
        default=Path.home() / "Code" / "Critiqor",
        help="Local Critiqor checkout (added to sys.path)",
    )
    args = parser.parse_args()

    root = args.critiqor_root
    if root.is_dir():
        sys.path.insert(0, str(root))

    try:
        from critiqor.diagnosis import generate_diagnosis
    except ImportError as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "critiqor_import_failed",
                    "detail": str(exc),
                    "hint": "Install Critiqor or pass --critiqor-root",
                }
            ),
            file=sys.stderr,
        )
        return 2

    events = load_events(args.events)
    session_json = ""
    if args.session and args.session.is_file():
        session_json = args.session.read_text(encoding="utf-8")

    diagnosis = generate_diagnosis(
        run_id=args.run_id,
        metadata={
            "tenant_id": "reliablerail",
            "agent_id": "webmcp-prototype",
            "framework": "webmcp",
            "visibility": "private",
        },
        events=events,
        session_json=session_json,
    )
    print(json.dumps(diagnosis, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
