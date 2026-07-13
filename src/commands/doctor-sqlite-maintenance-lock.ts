/** Serializes offline SQLite maintenance against the Gateway state owner. */
import {
  acquireGatewayLock,
  GatewayLockError,
  type GatewayLockOptions,
} from "../infra/gateway-lock.js";
import type { DoctorSessionSqliteMode } from "./doctor-session-sqlite-types.js";

const MAINTENANCE_LOCK_TIMEOUT_MS = 250;
const MAINTENANCE_LOCK_POLL_INTERVAL_MS = 25;

type MaintenanceLockOptions = Pick<
  GatewayLockOptions,
  | "lockDir"
  | "now"
  | "platform"
  | "pollIntervalMs"
  | "readProcessCmdline"
  | "readProcessStartTime"
  | "sleep"
  | "staleMs"
  | "timeoutMs"
>;

type DoctorSqliteMaintenanceLockDeps = {
  acquireLock?: typeof acquireGatewayLock;
  lockOptions?: MaintenanceLockOptions;
};

export function isDestructiveDoctorSessionSqliteMode(mode: DoctorSessionSqliteMode): boolean {
  return mode === "import" || mode === "compact" || mode === "restore" || mode === "recover";
}

/** Run one destructive doctor operation while excluding Gateway startup and peer maintenance. */
export async function withDoctorSqliteMaintenanceLock<T>(
  params: {
    env?: NodeJS.ProcessEnv;
    operation: string;
    run: () => Promise<T> | T;
  },
  deps: DoctorSqliteMaintenanceLockDeps = {},
): Promise<T> {
  const env = params.env ?? process.env;
  const acquireLock = deps.acquireLock ?? acquireGatewayLock;
  const lockOptions = deps.lockOptions;
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireLock({
      ...lockOptions,
      allowInTests: true,
      env,
      pollIntervalMs: lockOptions?.pollIntervalMs ?? MAINTENANCE_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: lockOptions?.timeoutMs ?? MAINTENANCE_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof GatewayLockError) {
      throw new Error(
        `Cannot run ${params.operation} while the Gateway or another SQLite maintenance command owns this OpenClaw state directory. Stop the Gateway and retry.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!lock) {
    throw new Error(`Cannot run ${params.operation} without exclusive OpenClaw state ownership.`);
  }

  try {
    return await params.run();
  } finally {
    await lock.release();
  }
}
