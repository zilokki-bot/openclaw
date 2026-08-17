import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import { CommandLane } from "./lanes.js";

/**
 * Nested parent → child → grandchild progress under a saturated subagent lane
 * (ARCH2 model: subagent lane 12, foreground reserved 1, maxSpawnDepth 2), and
 * "no retry storm": a task that fails or is aborted runs exactly once and is
 * never re-enqueued by the queue itself.
 *
 * Yield semantics: a parent that has spawned its child ENDS its turn
 * (`sessions_yield`), so its lane slot is released; the child is admitted from
 * the released slot even while every other slot is held by background work.
 */

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type CommandQueueModule = typeof import("./command-queue.js");

const SUBAGENT_MAX_CONCURRENT = 12;
const FOREGROUND_RESERVED_SLOTS = 1;

let enqueueCommandInLane: CommandQueueModule["enqueueCommandInLane"];
let getCommandLaneSnapshot: CommandQueueModule["getCommandLaneSnapshot"];
let resetAllLanes: CommandQueueModule["resetAllLanes"];
let setCommandLaneConcurrency: CommandQueueModule["setCommandLaneConcurrency"];

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("command queue — nested descendants and no retry storm", () => {
  beforeAll(async () => {
    ({ enqueueCommandInLane, getCommandLaneSnapshot, resetAllLanes, setCommandLaneConcurrency } =
      await import("./command-queue.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Subagent, SUBAGENT_MAX_CONCURRENT);
  });

  afterEach(() => {
    resetAllLanes();
    setCommandLaneConcurrency(CommandLane.Subagent, 1);
  });

  it("parent → child → grandchild all progress while 10 other background children hold the lane", async () => {
    const calls: string[] = [];
    const holdOthers = createDeferred();
    // 10 unrelated background children hold slots; with reserve 1 that leaves
    // exactly one admissible background slot for the parent chain.
    const others: Promise<string>[] = [];
    for (let i = 0; i < SUBAGENT_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS - 1; i += 1) {
      others.push(
        enqueueCommandInLane(
          CommandLane.Subagent,
          async () => {
            calls.push(`other-${i}`);
            await holdOthers.promise;
            return `other-${i}`;
          },
          { priority: "background" },
        ),
      );
    }
    await settle();
    expect(getCommandLaneSnapshot(CommandLane.Subagent).activeCount).toBe(
      SUBAGENT_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS - 1,
    );

    // depth 0: parent spawns child, then yields (its task completes → slot released).
    let child: Promise<string> | undefined;
    let grandchild: Promise<string> | undefined;
    const parent = enqueueCommandInLane(
      CommandLane.Subagent,
      async () => {
        calls.push("parent");
        // depth 1: child spawns grandchild, then yields.
        child = enqueueCommandInLane(
          CommandLane.Subagent,
          async () => {
            calls.push("child");
            // depth 2: grandchild does the work and returns (cannot spawn further).
            grandchild = enqueueCommandInLane(
              CommandLane.Subagent,
              async () => {
                calls.push("grandchild");
                return "grandchild";
              },
              { priority: "background" },
            );
            return "child-yielded";
          },
          { priority: "background" },
        );
        return "parent-yielded";
      },
      { priority: "background" },
    );

    await expect(parent).resolves.toBe("parent-yielded");
    await expect(child!).resolves.toBe("child-yielded");
    await expect(grandchild!).resolves.toBe("grandchild");
    expect(calls.filter((c) => !c.startsWith("other-"))).toEqual(["parent", "child", "grandchild"]);
    // The reserved foreground slot was never consumed by the background chain.
    const snapshot = getCommandLaneSnapshot(CommandLane.Subagent);
    expect(snapshot.activeCount).toBe(SUBAGENT_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS - 1);
    expect(snapshot.queuedCount).toBe(0);

    holdOthers.resolve();
    await expect(Promise.all(others)).resolves.toHaveLength(
      SUBAGENT_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS - 1,
    );
  });

  it("a failing background task runs exactly once, rejects, releases its slot and is never re-enqueued", async () => {
    let attempts = 0;
    const failing = enqueueCommandInLane(
      CommandLane.Subagent,
      async () => {
        attempts += 1;
        throw new Error("provider request failed");
      },
      { priority: "background" },
    );
    await expect(failing).rejects.toThrow("provider request failed");
    await settle();
    expect(attempts).toBe(1);
    const snapshot = getCommandLaneSnapshot(CommandLane.Subagent);
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.queuedCount).toBe(0);
    // A later task is admitted normally — the failed slot was released.
    await expect(
      enqueueCommandInLane(CommandLane.Subagent, async () => "next", { priority: "background" }),
    ).resolves.toBe("next");
    expect(attempts).toBe(1);
  });

  it("an aborted (timed-out) background task releases its slot exactly once and does not retry", async () => {
    let attempts = 0;
    const abort = new AbortController();
    const aborted = enqueueCommandInLane(
      CommandLane.Subagent,
      async (marker) => {
        attempts += 1;
        // Simulate the run's abort path: the task observes the abort and rejects once.
        await new Promise<void>((_, reject) => {
          abort.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return marker;
      },
      { priority: "background", taskTimeoutAbortSignal: abort.signal },
    );
    await settle();
    expect(getCommandLaneSnapshot(CommandLane.Subagent).activeCount).toBe(1);
    abort.abort();
    await expect(aborted).rejects.toThrow("aborted");
    await settle();
    expect(attempts).toBe(1);
    expect(getCommandLaneSnapshot(CommandLane.Subagent).activeCount).toBe(0);
    expect(getCommandLaneSnapshot(CommandLane.Subagent).queuedCount).toBe(0);
  });
});
