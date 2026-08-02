// Telegram plugin module implements polling lease behavior.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const TELEGRAM_POLLING_LEASES_KEY = Symbol.for("openclaw.telegram.pollingLeases");
const DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS = 5_000;
const DEFAULT_TELEGRAM_POLLING_FILE_LEASE_STALE_MS = 5 * 60 * 1_000;

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
  release: () => Promise<void>;
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
  fileLeaseStaleMs?: number;
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

type TelegramPollingFileLeaseOwner = {
  accountId: string;
  ownerId: string;
  pid: number;
  processStartClockTicks?: string;
  startedAt: number;
};

function parseLinuxProcessStartClockTicks(raw: string): string | undefined {
  const commEnd = raw.lastIndexOf(")");
  if (commEnd < 0) {
    return undefined;
  }
  const fieldsAfterComm = raw
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const startTime = fieldsAfterComm[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
}

async function readLinuxProcessStartClockTicks(pid: number): Promise<string | undefined> {
  try {
    return parseLinuxProcessStartClockTicks(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

async function readCurrentProcessStartClockTicks(): Promise<string | undefined> {
  return await readLinuxProcessStartClockTicks(process.pid);
}

async function readFileLeaseAgeMs(lockPath: string, nowMs: number): Promise<number> {
  try {
    const info = await stat(lockPath);
    return Math.max(0, nowMs - info.mtimeMs);
  } catch {
    return 0;
  }
}

async function readFileLeaseOwner(
  lockPath: string,
): Promise<TelegramPollingFileLeaseOwner | undefined> {
  const raw = await readFile(path.join(lockPath, "owner.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    accountId?: unknown;
    ownerId?: unknown;
    pid?: unknown;
    processStartClockTicks?: unknown;
    startedAt?: unknown;
  };
  if (
    typeof parsed.accountId !== "string" ||
    typeof parsed.ownerId !== "string" ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.startedAt !== "number" ||
    !Number.isFinite(parsed.startedAt)
  ) {
    return undefined;
  }
  return {
    accountId: parsed.accountId,
    ownerId: parsed.ownerId,
    pid: parsed.pid,
    ...(typeof parsed.processStartClockTicks === "string" && {
      processStartClockTicks: parsed.processStartClockTicks,
    }),
    startedAt: parsed.startedAt,
  };
}

async function isFileLeaseOwnerProcessStillActive(
  owner: TelegramPollingFileLeaseOwner,
): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) {
    return false;
  }
  if (owner.processStartClockTicks) {
    const currentStartClockTicks = await readLinuxProcessStartClockTicks(owner.pid);
    if (currentStartClockTicks && currentStartClockTicks !== owner.processStartClockTicks) {
      return false;
    }
  }
  return true;
}

async function acquireTelegramPollingFileLease(params: {
  accountId: string;
  leaseDir?: string;
  staleMs?: number;
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
      try {
        await writeFile(
          path.join(lockPath, "owner.json"),
          JSON.stringify({
            accountId: params.accountId,
            ownerId: randomUUID(),
            pid: process.pid,
            processStartClockTicks: await readCurrentProcessStartClockTicks(),
            startedAt: Date.now(),
          }),
          "utf8",
        );
      } catch (err) {
        await rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
        throw err;
      }
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
      const nowMs = Date.now();
      const staleMs = resolveTimerTimeoutMs(
        params.staleMs,
        DEFAULT_TELEGRAM_POLLING_FILE_LEASE_STALE_MS,
        0,
      );
      let existingOwner: TelegramPollingFileLeaseOwner | undefined;
      try {
        existingOwner = await readFileLeaseOwner(lockPath);
      } catch {
        existingOwner = undefined;
      }
      const leaseAgeMs =
        existingOwner?.startedAt === undefined
          ? await readFileLeaseAgeMs(lockPath, nowMs)
          : Math.max(0, nowMs - existingOwner.startedAt);
      if (!existingOwner) {
        if (leaseAgeMs < staleMs) {
          throw new Error(
            `Telegram polling file lease for bot token ${params.tokenFingerprint} is still initializing (${Math.round(leaseAgeMs)}ms old); refusing duplicate poller for account "${params.accountId}".`,
            { cause: err },
          );
        }
        await rm(lockPath, { force: true, recursive: true });
        continue;
      }
      if (await isFileLeaseOwnerProcessStillActive(existingOwner)) {
        throw new Error(
          `Telegram polling already active for bot token ${params.tokenFingerprint} on account "${existingOwner.accountId}" in pid ${existingOwner.pid}; refusing duplicate poller for account "${params.accountId}".`,
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
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await params.fileLease?.release();
      const current = params.registry.get(params.tokenFingerprint);
      if (current?.owner === owner) {
        params.registry.delete(params.tokenFingerprint);
      }
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
        staleMs: opts.fileLeaseStaleMs,
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
      staleMs: opts.fileLeaseStaleMs,
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

export const testing = {
  parseLinuxProcessStartClockTicks,
};
