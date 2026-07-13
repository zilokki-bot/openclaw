// Pins scheduled restart ordering against the reversible host-suspension fence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";
import {
  isGatewaySigusr1RestartExternallyAllowed,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewaySigusr1Restart,
  setGatewaySigusr1RestartPolicy,
  setPreRestartDeferralCheck,
} from "./restart.js";

function inspectors(): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => getActiveGatewayRootWorkCount(),
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
}

function countSigusr1Emits(calls: readonly unknown[][]): number {
  return calls.filter((args) => args[0] === "SIGUSR1").length;
}

function resetGatewayLifecycleState(): void {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayRestartStateForInProcessRestart();
}

describe("scheduled restart during gateway suspension", () => {
  const sigusr1Handler = () => {};

  beforeEach(() => {
    resetGatewayLifecycleState();
    setGatewaySigusr1RestartPolicy({ allowExternal: false });
    setPreRestartDeferralCheck(() => 0);
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    process.on("SIGUSR1", sigusr1Handler);
  });

  afterEach(() => {
    process.removeListener("SIGUSR1", sigusr1Handler);
    resetGatewayLifecycleState();
    setGatewaySigusr1RestartPolicy({ allowExternal: false });
    setPreRestartDeferralCheck(() => 0);
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defers a previously scheduled restart until a ready suspension resumes", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    scheduleGatewaySigusr1Restart({
      delayMs: 1_000,
      reason: "config.patch",
      skipCooldown: true,
    });

    const prepared = prepareGatewaySuspend({
      requestId: "request-restart-delay",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors(),
      createSuspensionId: () => "suspension-restart-delay",
    });
    expect(prepared.status).toBe("ready");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(0);

    expect(resumeGatewaySuspend("suspension-restart-delay")).toMatchObject({
      ok: true,
      resumed: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(1);
  });

  it("reports active work while a due restart is preparing to emit", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    let releasePreparation: () => void = () => {};
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    scheduleGatewaySigusr1Restart({
      delayMs: 0,
      reason: "config.patch",
      skipCooldown: true,
      emitHooks: {
        beforeEmit: async () => preparation,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    const prepared = prepareGatewaySuspend({
      requestId: "request-restart-preparing",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors(),
    });
    expect(prepared).toMatchObject({
      status: "busy",
      reason: "gateway-draining",
      activeCount: 1,
    });
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(0);

    releasePreparation();
    await vi.advanceTimersByTimeAsync(0);
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(1);

    expect(
      prepareGatewaySuspend({
        requestId: "request-after-restart-signal",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors(),
      }),
    ).toMatchObject({
      status: "busy",
      reason: "gateway-draining",
    });
  });

  it("resumes and clears a prepared suspension during an in-process restart", () => {
    const resumeScheduling = vi.fn();
    const prepared = prepareGatewaySuspend({
      requestId: "request-lifecycle-reset",
      pauseScheduling: vi.fn(),
      resumeScheduling,
      inspect: inspectors(),
      createSuspensionId: () => "suspension-lifecycle-reset",
    });
    expect(prepared).toMatchObject({ status: "ready" });

    resetGatewayLifecycleState();

    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(getGatewaySuspendStatus("suspension-lifecycle-reset")).toEqual({ status: "running" });
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("resets transient restart state without dropping live runtime bindings", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    const preRestartCheck = vi.fn(() => 0);
    setPreRestartDeferralCheck(preRestartCheck);
    setGatewaySigusr1RestartPolicy({ allowExternal: true });

    scheduleGatewaySigusr1Restart({ delayMs: 0, skipCooldown: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(1);
    expect(preRestartCheck).toHaveBeenCalledTimes(2);
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    resetGatewayLifecycleState();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(true);

    scheduleGatewaySigusr1Restart({ delayMs: 0, skipCooldown: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(2);
    expect(preRestartCheck).toHaveBeenCalledTimes(4);
  });
});
