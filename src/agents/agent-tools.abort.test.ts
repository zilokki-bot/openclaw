// Coverage for run-abort racing in wrapToolWithAbortSignal.
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

  it("rejects with AbortError when the run aborts while the tool promise never settles", async () => {
    // A wedged tool handler that never observes the signal and never settles.
    const runAbort = new AbortController();
    const execute = vi.fn(() => new Promise(() => {}));
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "wedged", execute }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-1", {});
    let outcome: { error?: unknown; status: "rejected" | "resolved" } | undefined;
    void executePromise.then(
      () => {
        outcome = { status: "resolved" };
      },
      (error: unknown) => {
        outcome = { status: "rejected", error };
      },
    );
    await flushMicrotasks();
    expect(outcome).toBeUndefined();

    runAbort.abort();
    const rejection = await executePromise.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome?.status).toBe("rejected");
    expect(rejection).toMatchObject({ name: "AbortError", message: "Aborted" });
  });

  it("handles a tool rejection when execute aborts the run synchronously", async () => {
    const runAbort = new AbortController();
    let rejectTool!: (error: unknown) => void;
    const execute = vi.fn(() => {
      runAbort.abort();
      return new Promise((_, reject) => {
        rejectTool = reject;
      });
    });
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "synchronous-abort", execute }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-1", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    rejectTool(new Error("tool observed the abort"));
    await flushMicrotasks();
  });

  it("rejects with AbortError when the per-call signal aborts through the combined signal", async () => {
    const runAbort = new AbortController();
    const callAbort = new AbortController();
    const execute = vi.fn(
      (_toolCallId: string, _params: unknown, _signal?: AbortSignal) => new Promise(() => {}),
    );
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "wedged", execute }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-1", {}, callAbort.signal);
    const passedSignal = execute.mock.calls[0]?.[2];
    expect(passedSignal).toBeInstanceOf(AbortSignal);
    expect(passedSignal).not.toBe(runAbort.signal);
    expect(passedSignal).not.toBe(callAbort.signal);

    callAbort.abort();
    expect(passedSignal?.aborted).toBe(true);
    await expect(executePromise).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
  });

  it("detaches a tool result that completes after the abort", async () => {
    const runAbort = new AbortController();
    let resolveTool!: (value: unknown) => void;
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveTool = resolve;
        }),
    );
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "late", execute }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-1", {});
    runAbort.abort();
    await expect(executePromise).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });

    // The tool finishes successfully after the run died; its result must not surface.
    resolveTool(textResult("late"));
    await flushMicrotasks();
    let lateOutcome: string | undefined;
    void executePromise.then(
      () => {
        lateOutcome = "resolved";
      },
      () => {
        lateOutcome = "rejected";
      },
    );
    await flushMicrotasks();
    expect(lateOutcome).toBe("rejected");
  });

  it("detaches a late tool rejection after the abort without an unhandled rejection", async () => {
    // Vitest fails the run on unhandled rejections, so a passing test proves the
    // background tool rejection stays handled after the race is lost.
    const runAbort = new AbortController();
    let rejectTool!: (error: unknown) => void;
    const execute = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectTool = reject;
        }),
    );
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "late", execute }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-1", {});
    runAbort.abort();
    await expect(executePromise).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });

    rejectTool(new Error("tool failed after the abort"));
    await flushMicrotasks();
  });

  it("resolves with the tool result unchanged when the run is not aborted", async () => {
    const runAbort = new AbortController();
    const result = textResult("ok");
    const execute = vi.fn(async () => result);
    const wrapped = wrapToolWithAbortSignal(asAgentTool({ name: "ok", execute }), runAbort.signal);

    await expect(wrapped.execute("call-1", {})).resolves.toBe(result);
    expect(execute).toHaveBeenCalledWith("call-1", {}, runAbort.signal, undefined);
  });

  it("rejects with the tool error unchanged when the run is not aborted", async () => {
    const runAbort = new AbortController();
    const toolError = new Error("tool exploded");
    const execute = vi.fn(async () => {
      throw toolError;
    });
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "fails", execute }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-1", {})).rejects.toBe(toolError);
  });

  it("preserves a non-Error tool rejection value unchanged when not aborted", async () => {
    const runAbort = new AbortController();
    const toolRejection = "tool rejected with a string";
    const execute = vi.fn(async () => {
      // Intentional non-Error rejection to prove pass-through semantics.
      // oxlint-disable-next-line typescript/only-throw-error
      throw toolRejection;
    });
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "fails", execute }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-1", {})).rejects.toBe(toolRejection);
  });

  it("throws AbortError before invoking execute when the signal is already aborted", async () => {
    const runAbort = new AbortController();
    runAbort.abort();
    const execute = vi.fn();
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "skipped", execute }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-1", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
