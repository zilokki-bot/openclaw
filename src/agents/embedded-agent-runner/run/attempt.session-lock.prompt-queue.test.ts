import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPromptSubmissionLockRelease,
  resetEmbeddedAttemptPromptSubmissionQueueForTest,
} from "./attempt.session-lock.js";

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Builds one independent session object with its own streamFn, as a second
 * concurrent attempt on the same agent+session identity would.
 */
function makeSession(params: {
  order: string[];
  label: string;
  gate?: Deferred;
  entered?: Deferred;
}): { agent: { streamFn: (...args: unknown[]) => Promise<string> } } {
  return {
    agent: {
      streamFn: async () => {
        params.order.push(`${params.label}:enter`);
        params.entered?.resolve();
        if (params.gate) {
          await params.gate.promise;
        }
        params.order.push(`${params.label}:exit`);
        return params.label;
      },
    },
  };
}

/** Lets every already-scheduled continuation run without inventing a tick count. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  resetEmbeddedAttemptPromptSubmissionQueueForTest();
});

describe("prompt submission serialization for one agent+session identity", () => {
  it("does not start the second prompt until the first one has settled", async () => {
    const order: string[] = [];
    const firstGate = deferred();
    const firstEntered = deferred();
    const first = makeSession({ order, label: "first", gate: firstGate, entered: firstEntered });
    const second = makeSession({ order, label: "second" });

    for (const [session, label] of [
      [first, "first"],
      [second, "second"],
    ] as const) {
      installPromptSubmissionLockRelease({
        session,
        agentId: "main",
        sessionKey: "agent:main:main",
        releaseForPrompt: vi.fn(async () => {
          order.push(`${label}:release`);
        }),
        reacquireAfterPrompt: vi.fn(async () => {
          order.push(`${label}:reacquire`);
        }),
      });
    }

    const firstRun = first.agent.streamFn();
    const secondRun = second.agent.streamFn();
    await firstEntered.promise;
    await flushMicrotasks();

    // The queue must hold the second submission back entirely — not merely its
    // provider call, but its release/reacquire cycle too.
    expect(order).toEqual(["first:release", "first:enter"]);

    firstGate.resolve();
    await expect(firstRun).resolves.toBe("first");
    await expect(secondRun).resolves.toBe("second");

    expect(order).toEqual([
      "first:release",
      "first:enter",
      "first:exit",
      "first:reacquire",
      "second:release",
      "second:enter",
      "second:exit",
      "second:reacquire",
    ]);
  });

  it("releases the queue turn when the first prompt rejects", async () => {
    const order: string[] = [];
    const promptError = new Error("provider failed");
    const first = {
      agent: {
        streamFn: async () => {
          order.push("first:enter");
          throw promptError;
        },
      },
    };
    const second = makeSession({ order, label: "second" });

    installPromptSubmissionLockRelease({
      session: first,
      agentId: "main",
      sessionKey: "agent:main:main",
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => undefined),
    });
    installPromptSubmissionLockRelease({
      session: second,
      agentId: "main",
      sessionKey: "agent:main:main",
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => undefined),
    });

    const firstRun = first.agent.streamFn();
    const secondRun = second.agent.streamFn();

    await expect(firstRun).rejects.toBe(promptError);
    await expect(secondRun).resolves.toBe("second");
    expect(order).toEqual(["first:enter", "second:enter", "second:exit"]);
  });

  it("does not serialize prompts of different session identities", async () => {
    const order: string[] = [];
    const firstGate = deferred();
    const first = makeSession({ order, label: "first", gate: firstGate });
    const other = makeSession({ order, label: "other" });

    installPromptSubmissionLockRelease({
      session: first,
      agentId: "main",
      sessionKey: "agent:main:main",
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => undefined),
    });
    installPromptSubmissionLockRelease({
      session: other,
      agentId: "main",
      sessionKey: "agent:main:other",
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => undefined),
    });

    const firstRun = first.agent.streamFn();
    await expect(other.agent.streamFn()).resolves.toBe("other");
    expect(order).toContain("other:exit");

    firstGate.resolve();
    await expect(firstRun).resolves.toBe("first");
  });

  it("takes the agent identity from sessionTarget when agentId is not passed", async () => {
    const order: string[] = [];
    const firstGate = deferred();
    const firstEntered = deferred();
    const first = makeSession({ order, label: "first", gate: firstGate, entered: firstEntered });
    const second = makeSession({ order, label: "second" });

    for (const session of [first, second]) {
      installPromptSubmissionLockRelease({
        session,
        sessionKey: "agent:main:main",
        sessionTarget: { agentId: "main", sessionKey: "agent:main:main" },
        releaseForPrompt: vi.fn(async () => undefined),
        reacquireAfterPrompt: vi.fn(async () => undefined),
      });
    }

    const firstRun = first.agent.streamFn();
    const secondRun = second.agent.streamFn();
    await firstEntered.promise;
    await flushMicrotasks();

    expect(order).toEqual(["first:enter"]);

    firstGate.resolve();
    await expect(firstRun).resolves.toBe("first");
    await expect(secondRun).resolves.toBe("second");
  });

  it("rejects a queued prompt whose abort signal fires while it waits", async () => {
    const order: string[] = [];
    const firstGate = deferred();
    const abortReason = new Error("run aborted");
    const controller = new AbortController();
    const first = makeSession({ order, label: "first", gate: firstGate });
    const second = makeSession({ order, label: "second" });

    installPromptSubmissionLockRelease({
      session: first,
      agentId: "main",
      sessionKey: "agent:main:main",
      releaseForPrompt: vi.fn(async () => undefined),
      reacquireAfterPrompt: vi.fn(async () => undefined),
    });
    const secondRelease = vi.fn(async () => undefined);
    installPromptSubmissionLockRelease({
      session: second,
      agentId: "main",
      sessionKey: "agent:main:main",
      abortSignal: controller.signal,
      releaseForPrompt: secondRelease,
      reacquireAfterPrompt: vi.fn(async () => undefined),
    });

    const firstRun = first.agent.streamFn();
    const secondRun = second.agent.streamFn();
    await Promise.resolve();

    controller.abort(abortReason);
    await expect(secondRun).rejects.toBe(abortReason);
    // An aborted waiter must never have touched the session lock.
    expect(secondRelease).not.toHaveBeenCalled();
    expect(order).not.toContain("second:enter");

    firstGate.resolve();
    await expect(firstRun).resolves.toBe("first");
  });

  it("runs without a queue when the session identity is incomplete", async () => {
    const order: string[] = [];
    const firstGate = deferred();
    const first = makeSession({ order, label: "first", gate: firstGate });
    const second = makeSession({ order, label: "second" });

    for (const session of [first, second]) {
      installPromptSubmissionLockRelease({
        session,
        releaseForPrompt: vi.fn(async () => undefined),
        reacquireAfterPrompt: vi.fn(async () => undefined),
      });
    }

    const firstRun = first.agent.streamFn();
    await expect(second.agent.streamFn()).resolves.toBe("second");

    firstGate.resolve();
    await expect(firstRun).resolves.toBe("first");
  });
  it("rejects a prompt whose abort signal fired before it reached the queue", async () => {
    const order: string[] = [];
    const abortReason = new Error("aborted before submission");
    const controller = new AbortController();
    controller.abort(abortReason);
    const first = makeSession({ order, label: "first" });
    const release = vi.fn(async () => undefined);

    installPromptSubmissionLockRelease({
      session: first,
      agentId: "main",
      sessionKey: "agent:main:main",
      abortSignal: controller.signal,
      releaseForPrompt: release,
      reacquireAfterPrompt: vi.fn(async () => undefined),
    });

    await expect(first.agent.streamFn()).rejects.toBe(abortReason);
    expect(release).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("keeps serving later waiters after one of them is aborted mid-queue", async () => {
    const order: string[] = [];
    const firstGate = deferred();
    const firstEntered = deferred();
    const abortReason = new Error("second aborted");
    const controller = new AbortController();
    const first = makeSession({ order, label: "first", gate: firstGate, entered: firstEntered });
    const second = makeSession({ order, label: "second" });
    const third = makeSession({ order, label: "third" });

    for (const [session, signal] of [
      [first, undefined],
      [second, controller.signal],
      [third, undefined],
    ] as const) {
      installPromptSubmissionLockRelease({
        session,
        agentId: "main",
        sessionKey: "agent:main:main",
        ...(signal ? { abortSignal: signal } : {}),
        releaseForPrompt: vi.fn(async () => undefined),
        reacquireAfterPrompt: vi.fn(async () => undefined),
      });
    }

    const firstRun = first.agent.streamFn();
    const secondRun = second.agent.streamFn();
    const thirdRun = third.agent.streamFn();
    await firstEntered.promise;

    controller.abort(abortReason);
    await expect(secondRun).rejects.toBe(abortReason);

    // The aborted waiter must hand its turn on, not strand everyone behind it.
    firstGate.resolve();
    await expect(firstRun).resolves.toBe("first");
    await expect(thirdRun).resolves.toBe("third");
    expect(order).toEqual(["first:enter", "first:exit", "third:enter", "third:exit"]);
  });
});
