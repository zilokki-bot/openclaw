// Telegram plugin module implements polling lease behavior.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const TELEGRAM_POLLING_LEASES_KEY = Symbol.for("openclaw.telegram.pollingLeases");
const DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS = 5_000;

type TelegramPollingLeaseEntry = {
  accountId: string;
  abortSignal?: AbortSignal;
  done: Promise<void>;
  fileLease?: TelegramPollingFileLease;
  owner: symbol;
  resolveDone: () => void;
  startedAt: number;
};

type TelegramPollingLeaseRegistry = Map<string, TelegramPollingLeaseEntry>;

type TelegramPollingLease = {
  tokenFingerprint: string;
  waitedForPrevious: boolean;
  replacedStoppingPrevious: boolean;
  release: () => void;
};

type TelegramPollingFileLease = {
  path: string;
  release: () => Promise<void>;
};

type AcquireTelegramPollingLeaseOpts = {
  token: string;
  accountId: string;
  abortSignal?: AbortSignal;
  waitMs?: number;
  leaseDir?: string;
};

type ReleaseStoppedTelegramPollingLeaseOpts = {
  token: string;
  accountId: string;
  waitMs?: number;
};

type WaitForPreviousResult = "released" | "timeout" | "aborted";

function pollingLeaseRegistry(): TelegramPollingLeaseRegistry {
  const proc = process as NodeJS.Process & {
    [TELEGRAM_POLLING_LEASES_KEY]?: TelegramPollingLeaseRegistry;
  };
  proc[TELEGRAM_POLLING_LEASES_KEY] ??= new Map();
  return proc[TELEGRAM_POLLING_LEASES_KEY];
}

function createDuplicatePollingError(params: {
  accountId: string;
  existing: TelegramPollingLeaseEntry;
  tokenFingerprint: string;
}): Error {
  const ageMs = Math.max(0, Date.now() - params.existing.startedAt);
  const ageSeconds = Math.round(ageMs / 1000);
  return new Error(
    `Telegram polling already active for bot token ${params.tokenFingerprint} on account "${params.existing.accountId}" (${ageSeconds}s old); refusing duplicate poller for account "${params.accountId}". Stop the existing OpenClaw gateway/poller or use a different bot token.`,
  );
}

async function waitForPreviousRelease(params: {
  done: Promise<void>;
  signal?: AbortSignal;
  waitMs: number;
}): Promise<WaitForPreviousResult> {
  if (params.signal?.aborted) {
    return "aborted";
  }
  if (params.waitMs <= 0) {
    return "timeout";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const waitMs = resolveTimerTimeoutMs(params.waitMs, DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS, 0);
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
      timer.unref?.();
    });
    const aborted = new Promise<"aborted">((resolve) => {
      abortListener = () => resolve("aborted");
      params.signal?.addEventListener("abort", abortListener, { once: true });
    });
    const released = params.done.then(() => "released" as const);
    return await Promise.race([released, timeout, aborted]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (abortListener) {
      params.signal?.removeEventListener("abort", abortListener);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pollingFileLeasePath(params: { leaseDir: string; tokenFingerprint: string }): string {
  return path.join(params.leaseDir, `${params.tokenFingerprint}.lock`);
}

async function acquireTelegramPollingFileLease(params: {
  accountId: string;
  leaseDir?: string;
  tokenFingerprint: string;
}): Promise<TelegramPollingFileLease | undefined> {
  if (!params.leaseDir) {
    return undefined;
  }
  await mkdir(params.leaseDir, { recursive: true });
  const lockPath = pollingFileLeasePath({
    leaseDir: params.leaseDir,
    tokenFingerprint: params.tokenFingerprint,
  });
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ accountId: params.accountId, pid: process.pid, startedAt: Date.now() }),
        "utf8",
      );
      return {
        path: lockPath,
        release: async () => {
          await rm(lockPath, { force: true, recursive: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      let existingAccountId = "unknown";
      let existingPid: number | undefined;
      try {
        const raw = await readFile(path.join(lockPath, "owner.json"), "utf8");
        const parsed = JSON.parse(raw) as { accountId?: unknown; pid?: unknown };
        existingAccountId =
          typeof parsed.accountId === "string" ? parsed.accountId : existingAccountId;
        existingPid = typeof parsed.pid === "number" ? parsed.pid : undefined;
      } catch {
        // Missing or corrupt owner metadata is treated as stale and recovered below.
      }
      if (existingPid !== undefined && isProcessAlive(existingPid)) {
        throw new Error(
          `Telegram polling already active for bot token ${params.tokenFingerprint} on account "${existingAccountId}" in pid ${existingPid}; refusing duplicate poller for account "${params.accountId}".`,
          { cause: err },
        );
      }
      await rm(lockPath, { force: true, recursive: true });
    }
  }
}

function createLease(params: {
  accountId: string;
  abortSignal?: AbortSignal;
  fileLease?: TelegramPollingFileLease;
  registry: TelegramPollingLeaseRegistry;
  tokenFingerprint: string;
  waitedForPrevious: boolean;
  replacedStoppingPrevious: boolean;
}): TelegramPollingLease {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const owner = Symbol(`telegram-polling:${params.accountId}`);
  const entry: TelegramPollingLeaseEntry = {
    accountId: params.accountId,
    abortSignal: params.abortSignal,
    done,
    fileLease: params.fileLease,
    owner,
    resolveDone,
    startedAt: Date.now(),
  };
  params.registry.set(params.tokenFingerprint, entry);

  let released = false;
  return {
    tokenFingerprint: params.tokenFingerprint,
    waitedForPrevious: params.waitedForPrevious,
    replacedStoppingPrevious: params.replacedStoppingPrevious,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = params.registry.get(params.tokenFingerprint);
      if (current?.owner === owner) {
        params.registry.delete(params.tokenFingerprint);
      }
      void params.fileLease?.release().catch(() => undefined);
      resolveDone();
    },
  };
}

export async function acquireTelegramPollingLease(
  opts: AcquireTelegramPollingLeaseOpts,
): Promise<TelegramPollingLease> {
  const registry = pollingLeaseRegistry();
  const fingerprint = fingerprintTelegramBotToken(opts.token);
  const waitMs = opts.waitMs ?? DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS;
  let waitedForPrevious = false;

  for (;;) {
    const existing = registry.get(fingerprint);
    if (!existing) {
      const fileLease = await acquireTelegramPollingFileLease({
        accountId: opts.accountId,
        leaseDir: opts.leaseDir,
        tokenFingerprint: fingerprint,
      });
      return createLease({
        accountId: opts.accountId,
        abortSignal: opts.abortSignal,
        fileLease,
        registry,
        tokenFingerprint: fingerprint,
        waitedForPrevious,
        replacedStoppingPrevious: false,
      });
    }

    if (!existing.abortSignal?.aborted) {
      throw createDuplicatePollingError({
        accountId: opts.accountId,
        existing,
        tokenFingerprint: fingerprint,
      });
    }

    waitedForPrevious = true;
    const waitResult = await waitForPreviousRelease({
      done: existing.done,
      signal: opts.abortSignal,
      waitMs,
    });
    if (waitResult === "aborted") {
      throw new Error(
        `Telegram polling start aborted while waiting for previous poller for bot token ${fingerprint} to stop.`,
      );
    }

    const current = registry.get(fingerprint);
    if (current !== existing) {
      continue;
    }
    if (waitResult === "released") {
      continue;
    }

    const fileLease = await acquireTelegramPollingFileLease({
      accountId: opts.accountId,
      leaseDir: opts.leaseDir,
      tokenFingerprint: fingerprint,
    });
    return createLease({
      accountId: opts.accountId,
      abortSignal: opts.abortSignal,
      fileLease,
      registry,
      tokenFingerprint: fingerprint,
      waitedForPrevious,
      replacedStoppingPrevious: true,
    });
  }
}

export async function releaseStoppedTelegramPollingLease(
  opts: ReleaseStoppedTelegramPollingLeaseOpts,
): Promise<boolean> {
  const registry = pollingLeaseRegistry();
  const fingerprint = fingerprintTelegramBotToken(opts.token);
  const existing = registry.get(fingerprint);
  if (!existing || existing.accountId !== opts.accountId) {
    return false;
  }

  if (!existing.abortSignal?.aborted) {
    return false;
  }

  const waitResult = await waitForPreviousRelease({
    done: existing.done,
    waitMs: opts.waitMs ?? DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS,
  });
  if (waitResult === "released" || registry.get(fingerprint) !== existing) {
    return false;
  }

  registry.delete(fingerprint);
  await existing.fileLease?.release().catch(() => undefined);
  existing.resolveDone();
  return true;
}

export function resetTelegramPollingLeasesForTests(): void {
  pollingLeaseRegistry().clear();
}
