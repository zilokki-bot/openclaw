import { describe, expect, it, vi } from "vitest";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

type ExecuteMock = ReturnType<typeof vi.fn>;

function asAgentTool(tool: { execute: ExecuteMock; name: string }): AnyAgentTool {
  return { description: tool.name, parameters: {}, ...tool } as unknown as AnyAgentTool;
}

function textResult(text: string) {
  return { content: [{ type: "text", text }], details: {} };
}

describe("wrapToolWithAbortSignal", () => {
  it("preserves the successful result when sessions_yield intentionally aborts its own run", async () => {
    const runAbort = new AbortController();
    const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
    const wrapped = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: "requester",
        onYield: () => runAbort.abort(handoffReason),
      }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {})).resolves.toMatchObject({
      details: { status: "yielded", message: "Turn yielded." },
    });
    expect(runAbort.signal.reason).toBe(handoffReason);
  });

  it("still aborts a concurrent sibling when sessions_yield hands off the run", async () => {
    const runAbort = new AbortController();
    const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
    const sibling = wrapToolWithAbortSignal(
      asAgentTool({ name: "wedged", execute: vi.fn(() => new Promise<never>(() => {})) }),
      runAbort.signal,
    );
    const siblingAborted = expect(sibling.execute("call-sibling", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    const yieldTool = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: "requester",
        onYield: () => runAbort.abort(handoffReason),
      }),
      runAbort.signal,
    );

    await expect(yieldTool.execute("call-yield", {})).resolves.toMatchObject({
      details: { status: "yielded" },
    });
    await siblingAborted;
  });

  it("preserves the handoff when distinct run and per-call signals both yield", async () => {
    const runAbort = new AbortController();
    const callAbort = new AbortController();
    const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
    const wrapped = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: "requester",
        onYield: () => {
          runAbort.abort(handoffReason);
          callAbort.abort(handoffReason);
        },
      }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {}, callAbort.signal)).resolves.toMatchObject({
      details: { status: "yielded" },
    });
  });

  it.each([
    { name: "ordinary caller cancellation", reason: new Error("operator cancelled") },
    {
      name: "a caller-authored lookalike handoff",
      reason: { code: "sessions_yield", turnHandoff: true },
    },
  ])("rejects sessions_yield for $name without an owner-authored handoff", async ({ reason }) => {
    const runAbort = new AbortController();
    const callAbort = new AbortController();
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "sessions_yield", execute: vi.fn(() => new Promise<never>(() => {})) }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-yield", {}, callAbort.signal);
    callAbort.abort(reason);

    await expect(executePromise).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    expect(runAbort.signal.aborted).toBe(false);
  });

  it.each([
    { name: "ordinary cancellation", reason: new Error("operator cancelled") },
    { name: "a missing handoff flag", reason: { code: "sessions_yield" } },
    { name: "a disabled handoff flag", reason: { code: "sessions_yield", turnHandoff: false } },
    { name: "a different handoff owner", reason: { code: "different", turnHandoff: true } },
  ])("rejects sessions_yield when its run owner aborts with $name", async ({ reason }) => {
    const runAbort = new AbortController();
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({
        name: "sessions_yield",
        execute: vi.fn(async () => {
          runAbort.abort(reason);
          return textResult("late");
        }),
      }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
  });

  it("does not start sessions_yield when the run was already handed off", async () => {
    const runAbort = new AbortController();
    runAbort.abort({ code: "sessions_yield", turnHandoff: true });
    const onYield = vi.fn();
    const wrapped = wrapToolWithAbortSignal(
      createSessionsYieldTool({ sessionId: "requester", onYield }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("preserves an actual sessions_yield failure after its owner starts the handoff", async () => {
    const runAbort = new AbortController();
    const yieldError = new Error("yield bookkeeping failed");
    const wrapped = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: "requester",
        onYield: () => {
          runAbort.abort({ code: "sessions_yield", turnHandoff: true });
          throw yieldError;
        },
      }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {})).rejects.toBe(yieldError);
  });

  it("rejects a wedged tool promptly when the run aborts", async () => {
    const runAbort = new AbortController();
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "wedged", execute: vi.fn(() => new Promise<never>(() => {})) }),
      runAbort.signal,
    );

    const execution = wrapped.execute("call-wedged", {});
    runAbort.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
  });
});
