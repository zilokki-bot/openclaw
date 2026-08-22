import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import { CommandLane } from "./lanes.js";

/**
 * Target capacity model for a Primary gateway that runs coding subagents and
 * still has to answer its foreground/control line (Black Rock ARCH2, 2026-08-17):
 *
 *   agents.defaults.maxConcurrent           = 12  (main lane slots)
 *   agents.defaults.subagents.maxConcurrent = 12  (subagent lane slots)
 *   agents.defaults.subagents.maxChildrenPerAgent = 6
 *   agents.defaults.subagents.maxSpawnDepth = 2
 *   foregroundReservedSlots (implicit)      = 1   (last slot of a multi-slot lane)
 *
 * The queue guarantees, independent of any polling:
 *   1. a foreground/control turn is admitted while background work fills the
 *      lane up to (maxConcurrent - 1);
 *   2. background work is not starved when no foreground work is queued and
 *      more than one slot is open;
 *   3. a saturated subagent lane never blocks foreground admission on the main
 *      lane (lanes are independent);
 *   4. all queued background entries eventually run once foreground work is done.
 */

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type CommandQueueModule = typeof import("./command-queue.js");

const TARGET_MAIN_MAX_CONCURRENT = 12;
const TARGET_SUBAGENT_MAX_CONCURRENT = 12;
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
  // Two microtask hops let the drain loop observe the new queue state.
  await Promise.resolve();
  await Promise.resolve();
}

function fillLaneWithBackground(
  lane: string,
  count: number,
  release: { promise: Promise<void> },
  calls: string[],
): Promise<string>[] {
  const jobs: Promise<string>[] = [];
  for (let i = 0; i < count; i += 1) {
    const label = `${lane}-bg-${i + 1}`;
    jobs.push(
      enqueueCommandInLane(
        lane,
        async () => {
          calls.push(label);
          await release.promise;
          return label;
        },
        { priority: "background" },
      ),
    );
  }
  return jobs;
}

describe("command queue capacity model (main 12 / subagent 12 / foreground reserved 1)", () => {
  beforeAll(async () => {
    ({ enqueueCommandInLane, getCommandLaneSnapshot, resetAllLanes, setCommandLaneConcurrency } =
      await import("./command-queue.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Main, TARGET_MAIN_MAX_CONCURRENT);
    setCommandLaneConcurrency(CommandLane.Subagent, TARGET_SUBAGENT_MAX_CONCURRENT);
  });

  afterEach(() => {
    resetAllLanes();
    setCommandLaneConcurrency(CommandLane.Main, 1);
    setCommandLaneConcurrency(CommandLane.Subagent, 1);
  });

  it("admits a foreground turn while background work fills main lane to maxConcurrent-1", async () => {
    const calls: string[] = [];
    const release = createDeferred();
    const background = fillLaneWithBackground(
      CommandLane.Main,
      TARGET_MAIN_MAX_CONCURRENT,
      release,
      calls,
    );
    await settle();

    // Exactly maxConcurrent - reserved background entries run; the last slot is held.
    const running = calls.filter((c) => c.startsWith(`${CommandLane.Main}-bg-`)).length;
    expect(running).toBe(TARGET_MAIN_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS);
    const snapshot = getCommandLaneSnapshot(CommandLane.Main);
    expect(snapshot.activeCount).toBe(TARGET_MAIN_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS);
    expect(snapshot.queuedCount).toBe(FOREGROUND_RESERVED_SLOTS);

    // Foreground/control turn goes straight into the reserved slot.
    const foreground = enqueueCommandInLane(CommandLane.Main, async () => {
      calls.push("foreground");
      return "foreground";
    });
    await expect(foreground).resolves.toBe("foreground");
    expect(calls).toContain("foreground");
    expect(calls.indexOf("foreground")).toBeLessThan(TARGET_MAIN_MAX_CONCURRENT);

    // No starvation: once background work drains, every queued background entry runs.
    release.resolve();
    await expect(Promise.all(background)).resolves.toHaveLength(TARGET_MAIN_MAX_CONCURRENT);
  });

  it("does not starve background work when no foreground work is queued", async () => {
    const calls: string[] = [];
    const release = createDeferred();
    const background = fillLaneWithBackground(
      CommandLane.Main,
      TARGET_MAIN_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS,
      release,
      calls,
    );
    await settle();
    // Below the reserve boundary every background entry is admitted immediately.
    expect(calls).toHaveLength(TARGET_MAIN_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS);
    release.resolve();
    await expect(Promise.all(background)).resolves.toHaveLength(
      TARGET_MAIN_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS,
    );
  });

  it("keeps main-lane foreground admission independent from a saturated subagent lane", async () => {
    const calls: string[] = [];
    const release = createDeferred();
    const subagents = fillLaneWithBackground(
      CommandLane.Subagent,
      TARGET_SUBAGENT_MAX_CONCURRENT + 4,
      release,
      calls,
    );
    await settle();
    const subSnapshot = getCommandLaneSnapshot(CommandLane.Subagent);
    expect(subSnapshot.activeCount).toBe(
      TARGET_SUBAGENT_MAX_CONCURRENT - FOREGROUND_RESERVED_SLOTS,
    );
    expect(subSnapshot.queuedCount).toBe(4 + FOREGROUND_RESERVED_SLOTS);

    // Foreground on the main lane is unaffected by subagent lane saturation.
    const foreground = enqueueCommandInLane(CommandLane.Main, async () => "control-turn");
    await expect(foreground).resolves.toBe("control-turn");
    expect(getCommandLaneSnapshot(CommandLane.Main).activeCount).toBe(0);

    release.resolve();
    await expect(Promise.all(subagents)).resolves.toHaveLength(TARGET_SUBAGENT_MAX_CONCURRENT + 4);
  });
});
