#!/usr/bin/env python3
"""
opencode_improvement.track — verdict/strategy outcome tracker

Usage:
  python3 -m opencode_improvement.track critic APPROVE "path:line — reason" --duration 120 --sim-id sim_xxx
  python3 -m opencode_improvement.track fixer success "fix simulation sandbox" --duration 45
  python3 -m opencode_improvement.track <agent> <outcome> "<reason>" [--duration MS] [--sim-id ID] [--file path:line]

Persists to shared/context.json → strategy_effectiveness + strategy_log
Mirrors ledger.ts recordOutcome().
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def resolve_context_path(root=None):
    repo = Path.cwd()
    candidates = [
        repo / "shared" / "context.json",
        repo / "packages" / "shared" / "context.json",
    ]
    if root:
        candidates = [Path(root) / "shared" / "context.json"] + candidates
    for p in candidates:
        if p.exists() or p.parent.exists():
            return p
    return candidates[0]


def load_context(p: Path):
    try:
        if not p.exists():
            return {}
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_context(ctx, p: Path):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(ctx, indent=2) + "\n", encoding="utf-8")
    # Mirror to packages/shared/context.json
    for alt in [Path.cwd() / "packages" / "shared" / "context.json", Path.cwd() / "shared" / "context.json"]:
        if alt != p and alt.parent.exists():
            try:
                alt.write_text(json.dumps(ctx, indent=2) + "\n", encoding="utf-8")
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description="Track strategy/critic verdict")
    parser.add_argument("agent", help="agent name (critic, fixer, etc.)")
    parser.add_argument("outcome", help="verdict/outcome (APPROVE/REJECT/REVISE/success/failure)")
    parser.add_argument("reason", nargs="?", default="", help="reason with file:line")
    parser.add_argument("--duration", type=int, default=None, help="duration ms")
    parser.add_argument("--sim-id", dest="sim_id", default=None)
    parser.add_argument("--sim_id", dest="sim_id", default=None)
    parser.add_argument("--file", dest="file_line", default=None, help="file:line")
    parser.add_argument("--root", default=None)
    args, _unknown = parser.parse_known_args()

    agent = args.agent
    outcome = args.outcome
    reason = args.reason or ""
    success = outcome.upper() in ("APPROVE", "SUCCESS", "TRUE", "1") or outcome.lower() == "success"

    ctx_path = resolve_context_path(args.root)
    ctx = load_context(ctx_path)
    se = ctx.get("strategy_effectiveness") or {}
    prev = se.get(agent) or {"count": 0, "completed": 0, "successes": 0, "success_rate": 1.0}
    prev_completed = prev.get("completed", 0)
    prev_successes = prev.get("successes", 0)
    # legacy fallback
    if prev_successes is None:
        prev_successes = round(prev.get("success_rate", 1.0) * prev_completed)

    next_completed = prev_completed + 1
    next_successes = prev_successes + (1 if success else 0)
    next_count = prev.get("count", 0) + 1
    next_rate = round((next_successes / next_completed) * 100) / 100 if next_completed else 1.0

    se[agent] = {
        "count": next_count,
        "completed": next_completed,
        "successes": next_successes,
        "success_rate": next_rate,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }
    ctx["strategy_effectiveness"] = se

    # strategy_log entry
    log = ctx.get("strategy_log") or []
    log.append({
        "strategy_chosen": agent,
        "agent_target": agent,
        "outcome": outcome,
        "reason": reason,
        "file_line": args.file_line,
        "sim_id": args.sim_id,
        "durationMs": args.duration,
        "at": datetime.now(timezone.utc).isoformat(),
    })
    if len(log) > 500:
        log = log[-500:]
    ctx["strategy_log"] = log
    ctx["last_updated"] = datetime.now(timezone.utc).isoformat()
    if "version" not in ctx:
        ctx["version"] = "1.0"
    # Ensure workflow trace keys exist
    ctx.setdefault("decisions", [])
    ctx.setdefault("active_tasks", [])
    ctx.setdefault("artifacts", {"files_created": [], "files_modified": []})
    ctx.setdefault("checkpoints", {"enabled": True, "dir": "shared/checkpoints", "retentionHours": 168, "keep": 5})

    save_context(ctx, ctx_path)
    print(json.dumps({"agent": agent, "outcome": outcome, "success": success, "success_rate": next_rate, "path": str(ctx_path)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
