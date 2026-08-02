// Telegram tests cover polling lease plugin behavior.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireTelegramPollingLease,
  releaseStoppedTelegramPollingLease,
  resetTelegramPollingLeasesForTests,
  testing,
} from "./polling-lease.js";

describe("Telegram polling lease", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    resetTelegramPollingLeasesForTests();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs = [];
  });

  async function createLeaseDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "telegram-polling-lease-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("refuses an active duplicate poller for the same bot token", async () => {
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
      }),
    ).rejects.toThrow('refusing duplicate poller for account "ops"');

    first.release();
  });

  it("refuses an old active duplicate poller for the same bot token", async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const first = await acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
        abortSignal: abort.signal,
      });

      await vi.advanceTimersByTimeAsync(6 * 60 * 1_000);

      await expect(
        acquireTelegramPollingLease({
          token: "123:abc",
          accountId: "ops",
        }),
      ).rejects.toThrow('refusing duplicate poller for account "ops"');

      first.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows concurrent pollers for different bot tokens", async () => {
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });
    const second = await acquireTelegramPollingLease({
      token: "456:def",
      accountId: "ops",
    });

    expect(first.tokenFingerprint).not.toBe(second.tokenFingerprint);

    first.release();
    second.release();
  });

  it("waits for an aborting same-token poller before acquiring", async () => {
    const oldAbort = new AbortController();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      abortSignal: oldAbort.signal,
    });
    oldAbort.abort();

    const acquire = acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      waitMs: 1_000,
    });
    await Promise.resolve();
    first.release();
    const second = await acquire;

    expect(second.waitedForPrevious).toBe(true);
    expect(second.replacedStoppingPrevious).toBe(false);

    second.release();
  });

  it("does not let stale release clear a replacement lease", async () => {
    vi.useFakeTimers();
    try {
      const oldAbort = new AbortController();
      const first = await acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "old",
        abortSignal: oldAbort.signal,
      });
      oldAbort.abort();

      const acquireReplacement = acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "new",
        waitMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      const replacement = await acquireReplacement;
      expect(replacement.replacedStoppingPrevious).toBe(true);

      first.release();

      await expect(
        acquireTelegramPollingLease({
          token: "123:abc",
          accountId: "third",
        }),
      ).rejects.toThrow('account "new"');

      replacement.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized duplicate-poller wait timers before scheduling", async () => {
    vi.useFakeTimers();
    try {
      const oldAbort = new AbortController();
      const first = await acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "old",
        abortSignal: oldAbort.signal,
      });
      oldAbort.abort();
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

      void acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "new",
        waitMs: Number.MAX_SAFE_INTEGER,
      }).catch(() => undefined);
      await Promise.resolve();

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      first.release();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("does not release a no-signal active lease", async () => {
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
      }),
    ).rejects.toThrow('refusing duplicate poller for account "ops"');

    await expect(
      releaseStoppedTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
      }),
    ).resolves.toBe(false);

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
      }),
    ).rejects.toThrow('account "default"');

    first.release();
  });

  it("does not release a non-aborted active lease", async () => {
    const abort = new AbortController();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      abortSignal: abort.signal,
    });

    await expect(
      releaseStoppedTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
      }),
    ).resolves.toBe(false);

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
      }),
    ).rejects.toThrow('account "default"');

    first.release();
  });

  it("releases an aborted same-account lease after the stop wait elapses", async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const first = await acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
        abortSignal: abort.signal,
      });
      abort.abort();

      const release = releaseStoppedTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
        waitMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(release).resolves.toBe(true);

      const next = await acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
      });
      next.release();
      first.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an aborted same-account lease immediately with no stop wait", async () => {
    const abort = new AbortController();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      abortSignal: abort.signal,
    });
    abort.abort();

    await expect(
      releaseStoppedTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
        waitMs: 0,
      }),
    ).resolves.toBe(true);

    const next = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });
    next.release();
    first.release();
  });

  it("refuses duplicate pollers across process registries with a shared file lease", async () => {
    const leaseDir = await createLeaseDir();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      leaseDir,
    });
    resetTelegramPollingLeasesForTests();

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
        leaseDir,
      }),
    ).rejects.toThrow('refusing duplicate poller for account "ops"');

    await first.release();
  });

  it("does not steal a fresh file lease before owner metadata is written", async () => {
    const leaseDir = await createLeaseDir();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      leaseDir,
    });
    const lockPath = path.join(leaseDir, `${first.tokenFingerprint}.lock`);
    await first.release();
    await mkdir(lockPath, { recursive: true });
    resetTelegramPollingLeasesForTests();

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
        leaseDir,
        fileLeaseStaleMs: 60_000,
      }),
    ).rejects.toThrow("still initializing");
  });

  it("recovers an ownerless file lease only after the stale window", async () => {
    const leaseDir = await createLeaseDir();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      leaseDir,
    });
    const lockPath = path.join(leaseDir, `${first.tokenFingerprint}.lock`);
    await first.release();
    await mkdir(lockPath, { recursive: true });
    resetTelegramPollingLeasesForTests();

    const next = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "ops",
      leaseDir,
      fileLeaseStaleMs: 0,
    });
    await next.release();
  });

  it("waits for file lease cleanup before allowing a fast reacquire", async () => {
    const leaseDir = await createLeaseDir();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      leaseDir,
    });
    await first.release();
    resetTelegramPollingLeasesForTests();

    const next = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      leaseDir,
    });
    await next.release();
  });

  it("recovers a stale file lease whose owner process is gone", async () => {
    const leaseDir = await createLeaseDir();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      leaseDir,
    });
    first.release();
    resetTelegramPollingLeasesForTests();

    const staleLock = path.join(leaseDir, `${first.tokenFingerprint}.lock`);
    await mkdir(staleLock, { recursive: true });
    await writeFile(
      path.join(staleLock, "owner.json"),
      JSON.stringify({ accountId: "old", pid: 9_999_999, startedAt: Date.now() - 60_000 }),
      "utf8",
    );

    const next = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      leaseDir,
      fileLeaseStaleMs: 0,
    });
    await next.release();
  });

  it("parses Linux process start ticks used to reject pid reuse", () => {
    const raw = "12345 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20 21";

    expect(testing.parseLinuxProcessStartClockTicks(raw)).toBe("424242");
  });
});
