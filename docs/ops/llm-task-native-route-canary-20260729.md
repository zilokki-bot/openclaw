---
summary: "Readiness gates for llm-task scoped embedded runs and TaskFlow child-agent route canaries"
read_when:
  - Verifying llm-task embedded-agent runs launched through Gateway caller context
  - Proving a Telegram or Codex coordination request can reach TaskFlow sub-agents
  - Avoiding first-line overload while using sessions_spawn and sessions_yield
title: "LLM Task Native Route Canary"
---

# LLM Task Native Route Canary

This runbook separates source readiness, server uptake, and live route proof for
the native TaskFlow path:

```text
main:telegram or codex-coord
  -> Pulse / TaskFlow session context
  -> sessions_spawn(runtime="subagent", sandbox="require", context="isolated")
  -> sessions_yield result
  -> optional rich Telegram response or Workboard receipt
```

Use this path for business cards, Canvas preparation, and other heavy work.
Do not put long audits, code, polling loops, or bulk prompts into the first-line
coord session. Mac coordination lanes are scarce; scalable work belongs in
server child-agent sessions.

## Source gate

`llm-task` embedded runs must preserve the trusted Gateway caller scope before a
route canary is meaningful.

Required source behavior:

- Read the current trusted Gateway caller identity from the plugin SDK.
- Pass the caller `agentId` into `runEmbeddedAgent`.
- Pass the caller `sessionKey` into `runEmbeddedAgent`.
- Fall back to `agentId: "main"` and `sessionKey: "agent:main:main"` only when
  no trusted Gateway caller identity exists.

Focused proof should include the `llm-task` tool tests and the Gateway caller
context tests that cover `/tools/invoke` identity propagation.

## Server uptake gate

Do not run a live `llm-task` route canary only because the source PR is green.
First prove the server runtime has the scoped embedded-run code installed.

Minimum read-only proof:

- Server OpenClaw version or package build identifier.
- Runtime `llm-task` code contains the caller-scope path.
- `/readyz` reports `degraded=false`.
- Running and queued task count is `0`.

If the runtime still has old `llm-task` code, the expected failure is:

```text
Cannot resolve SQLite session scope without an agent id
```

In that state, report `BLOCKED: runtime uptake missing`; do not run a live
canary to rediscover the same failure.

## Route canary

The first live route canary should be small and single-shot.

It must prove:

- The request starts from a real session context, not an anonymous HTTP worker.
- `llm-task` launches its embedded run with a resolvable agent/session scope.
- Pulse can spawn one sandbox child with `sessions_spawn`.
- The child returns through `sessions_yield`.
- The parent records a concise result.

Do not use `sessions_spawn` directly through `/tools/invoke`. The Gateway HTTP
tools API denies remote session orchestration by default because it is a remote
execution surface. The canary must go through the official agent session context
where tool policy and subagent policy apply.

Use `sandbox: "require"` for child agents. Do not pass a per-call timeout unless
the current OpenClaw command/help explicitly supports it; prefer configured
`agents.defaults.subagents.runTimeoutSeconds`.

## main:telegram route gate

For `main:telegram`, prove each layer separately:

- Inbound Telegram update from the owner reaches the Telegram channel runtime.
- The update binds to the expected `agent:main:telegram:*` session.
- The session can hand off heavy work through Pulse/TaskFlow without putting the
  heavy prompt into `main:telegram`, `main:main`, or `codex-coord`.
- Child work completes with `sessions_yield`.
- A rich Telegram response or Workboard receipt is sent only when the task needs
  a user-visible result.

Do not use Telegram smoke tests, restart the gateway, change config, change
model routing, edit auth, or mutate Workboard from this runbook without an
explicit operator go-ahead.

## Failure classification

| Symptom                                                   | Meaning                                                 | Safe next step                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Cannot resolve SQLite session scope without an agent id` | Runtime `llm-task` did not pass an embedded agent scope | Fix or install scoped `llm-task` code before canary                            |
| `/readyz` degraded or active tasks > 0                    | Server is not a clean canary window                     | Wait and retry read-only health later                                          |
| `sessions_send` accepted but no transcript/result         | Delivery receipt only                                   | Read the child transcript, task result, Workboard receipt, or `sessions_yield` |
| Duplicate Telegram polling offsets                        | Channel stability issue                                 | Diagnose read-only; do not send smoke messages until allowed                   |
| Stale giant `main:telegram` session                       | Session hygiene issue                                   | Reconnect or repair only with explicit operational approval                    |
