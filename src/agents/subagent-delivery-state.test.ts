// Subagent delivery-state tests cover current registry record normalization.
import { describe, expect, it } from "vitest";
import {
  isDeliverySuspended,
  normalizeSubagentRunState,
  resumeSuspendedDelivery,
} from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function baseRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:parent",
    requesterDisplayKey: "agent:main:parent",
    controllerSessionKey: "agent:main:parent",
    task: "inspect",
    cleanup: "keep",
    spawnMode: "run",
    createdAt: 100,
    startedAt: 100,
    expectsCompletionMessage: true,
    execution: { status: "running", startedAt: 100 },
    completion: { required: true },
    delivery: { status: "pending" },
    ...overrides,
  };
}

describe("normalizeSubagentRunState", () => {
  it("normalizes durable task ownership and generation metadata", () => {
    const entry = normalizeSubagentRunState(
      baseRun({ taskRunId: "  run-task-owner  ", generation: 2 }),
    );
    const malformed = normalizeSubagentRunState(
      baseRun({ taskRunId: "   ", generation: Number.NaN }),
    );
    const nonString = normalizeSubagentRunState({
      ...baseRun(),
      taskRunId: 42,
    } as unknown as SubagentRunRecord);

    expect(entry).toMatchObject({ taskRunId: "run-task-owner", generation: 2 });
    expect(malformed.taskRunId).toBeUndefined();
    expect(malformed.generation).toBeUndefined();
    expect(nonString.taskRunId).toBeUndefined();
  });

  it("normalizes the durable delete-dispatch boundary", () => {
    const valid = normalizeSubagentRunState(baseRun({ deleteCleanupDispatchedAt: 200 }));
    const malformed = normalizeSubagentRunState(baseRun({ deleteCleanupDispatchedAt: Number.NaN }));

    expect(valid.deleteCleanupDispatchedAt).toBe(200);
    expect(malformed.deleteCleanupDispatchedAt).toBeUndefined();
  });

  it("preserves valid killed reconciliation ownership metadata", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        suppressCompletionDelivery: true,
        killReconciliation: {
          killedAt: 200,
          suppressTaskDelivery: true,
          supersededAt: 300,
        },
      }),
    );

    expect(entry.killReconciliation).toEqual({
      killedAt: 200,
      suppressTaskDelivery: true,
      supersededAt: 300,
    });
    expect(entry.suppressCompletionDelivery).toBe(true);
  });

  it("drops malformed killed reconciliation metadata", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        killReconciliation: { killedAt: Number.NaN },
      }),
    );

    expect(entry.killReconciliation).toBeUndefined();
  });

  it("keeps only complete interrupted-recovery terminal ownership", () => {
    const terminal = {
      endedAt: 200,
      endedReason: "subagent-error" as const,
      outcome: { status: "error" as const, error: "restart interrupted run" },
      terminalOwner: "interrupted-recovery" as const,
    };
    const valid = normalizeSubagentRunState(baseRun(terminal));
    const malformed = [
      baseRun({ ...terminal, endedAt: undefined }),
      baseRun({ ...terminal, outcome: { status: "ok" } }),
      baseRun({ ...terminal, endedReason: "subagent-complete" }),
      baseRun({ ...terminal, pauseReason: "sessions_yield" }),
    ].map((entry) => normalizeSubagentRunState(entry));

    expect(valid.terminalOwner).toBe("interrupted-recovery");
    expect(malformed.every((entry) => entry.terminalOwner === undefined)).toBe(true);
  });

  it("clears stale cleanupHandled locks for unfinished restored cleanup", () => {
    const entry = normalizeSubagentRunState(baseRun({ cleanupHandled: true }));

    expect(entry.cleanupHandled).toBe(false);
  });

  it("clears stale cleanupHandled locks after delivered notification if cleanup did not finish", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        cleanupHandled: true,
        delivery: {
          status: "delivered",
          announcedAt: 400,
        },
      }),
    );

    expect(entry.cleanupHandled).toBe(false);
  });

  it("keeps discarded terminal delivery dormant across restart", () => {
    const entry = normalizeSubagentRunState(
      baseRun({
        cleanupHandled: true,
        delivery: {
          status: "discarded",
          discardedAt: 400,
          discardReason: "expired",
        },
      }),
    );

    expect(entry.cleanupHandled).toBe(true);
  });
});

describe("resumeSuspendedDelivery", () => {
  function suspendedRun(): SubagentRunRecord {
    const entry = normalizeSubagentRunState(baseRun({ endedAt: 200 }));
    entry.delivery = {
      status: "suspended",
      suspendedAt: 150,
      suspendedReason: "retry-limit",
      attemptCount: 4,
      lastError: "completion agent did not produce a visible reply",
      payload: {
        frozenResultText: "PULSE_SMOKE_DONE marker and one proof line",
      } as NonNullable<SubagentRunRecord["delivery"]>["payload"],
    };
    return entry;
  }

  it("re-arms the delivery and keeps the stored result", () => {
    const entry = suspendedRun();
    expect(isDeliverySuspended(entry)).toBe(true);

    expect(resumeSuspendedDelivery(entry)).toBe(true);

    // The announce path returns early on suspended entries, so clearing the
    // suspension is what makes a stored result reachable again.
    expect(isDeliverySuspended(entry)).toBe(false);
    expect(entry.delivery?.status).toBe("pending");
    expect(entry.delivery?.suspendedAt).toBeUndefined();
    expect(entry.delivery?.suspendedReason).toBeUndefined();
    // A fresh attempt budget, or the next failure would suspend it immediately.
    expect(entry.delivery?.attemptCount).toBe(0);
    expect(entry.delivery?.lastError).toBeNull();
    // The whole point: the answer that was never delivered survives untouched.
    expect(entry.delivery?.payload).toMatchObject({
      frozenResultText: "PULSE_SMOKE_DONE marker and one proof line",
    });
  });

  it("reports no-op instead of success when nothing is suspended", () => {
    const pending = normalizeSubagentRunState(baseRun({ endedAt: 200 }));
    pending.delivery = { status: "pending", attemptCount: 1 };

    expect(resumeSuspendedDelivery(pending)).toBe(false);
    expect(pending.delivery?.status).toBe("pending");
    expect(pending.delivery?.attemptCount).toBe(1);
  });

  it("does not treat a suspended status without a timestamp as resumable", () => {
    const entry = normalizeSubagentRunState(baseRun({ endedAt: 200 }));
    entry.delivery = { status: "suspended", attemptCount: 4 };

    expect(resumeSuspendedDelivery(entry)).toBe(false);
    expect(entry.delivery?.status).toBe("suspended");
  });
});
