# Workboard background admission reserve 2026-07-20

## Boundary

This repository change only adjusts local command-lane admission for trusted
gateway-owned background subagent runs. It does not start Workboard workers,
change live cron, change model/provider settings, restart the gateway, or prove
Telegram product latency on the running server.

## Problem

Plugin-owned Workboard/subagent traffic can be admitted through the same command
lane as user-visible work. When a lane has more than one slot, background
overflow runs could occupy every slot and leave no immediate capacity for a
foreground turn.

## Contract

- Gateway plugin-subagent runs are marked with internal trigger `overflow`.
- The command queue treats `priority: "background"` work as opportunistic.
- On lanes with `maxConcurrent > 1`, background work may use spare capacity but
  must not take the final open slot when no foreground work is queued.
- Single-concurrency lanes keep their existing FIFO behavior, because reserving
  their only slot would deadlock background-only lanes.

## Verification

Focused checks:

```bash
PATH=/opt/homebrew/bin:$PATH node scripts/run-vitest.mjs run \
  src/process/command-queue.test.ts \
  src/agents/command/attempt-execution.cli.test.ts

PATH=/opt/homebrew/bin:$PATH node scripts/run-vitest.mjs run \
  src/gateway/server-methods/agent.test.ts \
  -t "forwards plugin-owned additive tools only for tracked plugin subagent runs"

python3 /Users/dimm/BLACK_ROCK_workspace/scripts/doc-cascade-guard.py \
  src/process/command-queue.ts \
  src/process/command-queue.test.ts \
  src/agents/command/types.ts \
  src/agents/command/attempt-execution.ts \
  src/agents/command/attempt-execution.cli.test.ts \
  src/gateway/server-methods/agent.ts \
  src/gateway/server-methods/agent.test.ts \
  docs/ops/workboard-background-admission-reserve-20260720.md

git diff --check
```

Live validation after a separate Dimm GO should compare `/readyz` latency and
ordinary user-visible session responsiveness before and after bounded Workboard
traffic. A green repository test is not a live admission-capacity proof.
