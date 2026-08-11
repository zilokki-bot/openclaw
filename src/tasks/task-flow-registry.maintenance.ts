// Reconciles stale task-flow records with their child task state.
import { createHash } from "node:crypto";
import { appendLocalMaintenanceAudit } from "../infra/maintenance-audit.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { listTasksForFlowId } from "./runtime-internal.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import {
  listTaskFlowAuditFindings,
  summarizeTaskFlowAuditFindings,
  type TaskFlowAuditSummary,
} from "./task-flow-registry.audit.js";
import {
  deleteTaskFlowRecordById,
  getTaskFlowById,
  getTaskFlowRegistryRestoreFailure,
  listTaskFlowRecords,
  reloadTaskFlowRegistryFromStore,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

const TASK_FLOW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Counts task-flow registry maintenance actions without exposing individual records. */
type TaskFlowRegistryMaintenanceSummary = {
  reconciled: number;
  pruned: number;
};

/** Payload-free receipt for cancelling terminally-unlinked queued TaskFlows. */
export type OrphanedQueuedTaskFlowMaintenanceReceipt = {
  mode: "dry-run" | "apply";
  filters: {
    status: "queued";
    linkedTasks: "none";
    olderThanMs: number;
    limit: number;
    batch: number;
  };
  before: { count: number };
  selected: { count: number; idsSha256: string };
  applied: { count: number; idsSha256: string; skippedRace: number };
  after: { count: number };
  retention: { terminalTombstone: "cancelled"; retainedForMs: number };
  auditEventId?: string;
};

function maintenanceIdsSha256(ids: readonly string[]): string {
  return createHash("sha256")
    .update([...ids].toSorted().join("\n"))
    .digest("hex");
}

function maintenanceBoundedInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`${label} must be an integer between 1 and 1000.`);
  }
  return value;
}

type OrphanedQueuedFlowRow = { flow_id: string; revision: number | bigint };

const orphanedQueuedCountSql = `
  SELECT COUNT(*) AS count
  FROM flow_runs AS flow
  WHERE flow.status = 'queued'
    AND flow.updated_at <= ?
    AND NOT EXISTS (
      SELECT 1 FROM task_runs AS task WHERE task.parent_flow_id = flow.flow_id
    )
`;

const orphanedQueuedSelectSql = `
  SELECT flow.flow_id, flow.revision
  FROM flow_runs AS flow
  WHERE flow.status = 'queued'
    AND flow.updated_at <= ?
    AND NOT EXISTS (
      SELECT 1 FROM task_runs AS task WHERE task.parent_flow_id = flow.flow_id
    )
  ORDER BY flow.updated_at ASC, flow.flow_id ASC
  LIMIT ?
`;

const orphanedQueuedCancelSql = `
  UPDATE flow_runs
  SET status = 'cancelled',
      blocked_task_id = NULL,
      blocked_summary = NULL,
      wait_json = NULL,
      cancel_requested_at = ?,
      ended_at = ?,
      updated_at = ?,
      revision = revision + 1
  WHERE flow_id = ?
    AND revision = ?
    AND status = 'queued'
    AND updated_at <= ?
    AND NOT EXISTS (
      SELECT 1 FROM task_runs AS task WHERE task.parent_flow_id = flow_runs.flow_id
    )
`;

function orphanedQueuedCount(cutoff: number): number {
  const { db } = openOpenClawStateDatabase();
  const row = db.prepare(orphanedQueuedCountSql).get(cutoff) as
    | { count: number | bigint }
    | undefined;
  return Number(row?.count ?? 0);
}

/**
 * Preview or cancel queued TaskFlows that have never acquired a linked task.
 * Apply uses revision + state predicates atomically, leaves a cancelled tombstone,
 * and lets the existing seven-day terminal retention maintenance prune later.
 */
export function maintainOrphanedQueuedTaskFlows(params: {
  olderThanMs: number;
  limit?: number;
  batch?: number;
  apply?: boolean;
  now?: number;
}): OrphanedQueuedTaskFlowMaintenanceReceipt {
  assertTaskFlowRegistryMaintenanceReady();
  const limit = maintenanceBoundedInt(params.limit ?? 100, "limit");
  const batch = maintenanceBoundedInt(params.batch ?? Math.min(50, limit), "batch");
  if (batch > limit) {
    throw new Error("batch must not exceed limit.");
  }
  if (!Number.isSafeInteger(params.olderThanMs) || params.olderThanMs < 0) {
    throw new Error("olderThanMs must be a non-negative integer.");
  }
  const now = params.now ?? Date.now();
  const cutoff = now - params.olderThanMs;
  const before = orphanedQueuedCount(cutoff);
  const { db } = openOpenClawStateDatabase();
  const selected = db
    .prepare(orphanedQueuedSelectSql)
    .all(cutoff, limit) as OrphanedQueuedFlowRow[];
  const selectedIds = selected.map((row) => row.flow_id);
  const appliedIds: string[] = [];
  let auditEventId: string | undefined;
  if (params.apply && selected.length > 0) {
    auditEventId = runOpenClawStateWriteTransaction(({ db: txDb }) => {
      const cancel = txDb.prepare(orphanedQueuedCancelSql);
      for (let index = 0; index < selected.length; index += batch) {
        for (const flow of selected.slice(index, index + batch)) {
          const result = cancel.run(now, now, now, flow.flow_id, Number(flow.revision), cutoff);
          if (result.changes === 1) {
            appliedIds.push(flow.flow_id);
          }
        }
      }
      return appendLocalMaintenanceAudit({
        db: txDb,
        action: "taskflow_orphaned_queued",
        occurredAt: now,
        resultCount: appliedIds.length,
      });
    });
    // A CLI process can share this registry with the gateway process. Refresh only after
    // a successful write so later in-process maintenance cannot overwrite the tombstones.
    reloadTaskFlowRegistryFromStore();
  }
  const after = orphanedQueuedCount(cutoff);
  return {
    mode: params.apply ? "apply" : "dry-run",
    filters: {
      status: "queued",
      linkedTasks: "none",
      olderThanMs: params.olderThanMs,
      limit,
      batch,
    },
    before: { count: before },
    selected: { count: selectedIds.length, idsSha256: maintenanceIdsSha256(selectedIds) },
    applied: {
      count: appliedIds.length,
      idsSha256: maintenanceIdsSha256(appliedIds),
      skippedRace: params.apply ? selectedIds.length - appliedIds.length : 0,
    },
    after: { count: after },
    retention: { terminalTombstone: "cancelled", retainedForMs: TASK_FLOW_RETENTION_MS },
    ...(auditEventId ? { auditEventId } : {}),
  };
}

export function assertTaskFlowRegistryMaintenanceReady(): void {
  const restoreFailure = getTaskFlowRegistryRestoreFailure();
  if (restoreFailure) {
    throw new Error(
      `Task-flow registry restore failed: ${restoreFailure}. Refusing task maintenance.`,
    );
  }
}

function isTerminalFlow(flow: TaskFlowRecord): boolean {
  return (
    flow.status === "succeeded" ||
    flow.status === "blocked" ||
    flow.status === "failed" ||
    flow.status === "cancelled" ||
    flow.status === "lost"
  );
}

function hasActiveLinkedTasks(flowId: string): boolean {
  return listTasksForFlowId(flowId).some(isTaskFlowCancellationPending);
}

function resolveTerminalAt(flow: TaskFlowRecord): number {
  return flow.endedAt ?? flow.updatedAt ?? flow.createdAt;
}

function shouldPruneFlow(flow: TaskFlowRecord, now: number): boolean {
  if (!isTerminalFlow(flow)) {
    return false;
  }
  if (hasActiveLinkedTasks(flow.flowId)) {
    return false;
  }
  return now - resolveTerminalAt(flow) >= TASK_FLOW_RETENTION_MS;
}

function shouldFinalizeCancelledFlow(flow: TaskFlowRecord): boolean {
  if (flow.syncMode !== "managed") {
    return false;
  }
  if (flow.cancelRequestedAt == null || isTerminalFlow(flow)) {
    return false;
  }
  return !hasActiveLinkedTasks(flow.flowId);
}

function finalizeCancelledFlow(flow: TaskFlowRecord, now: number): boolean {
  let current = flow;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const endedAt = Math.max(now, current.updatedAt, current.cancelRequestedAt ?? now);
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: current.flowId,
      expectedRevision: current.revision,
      patch: {
        status: "cancelled",
        blockedTaskId: null,
        blockedSummary: null,
        waitJson: null,
        endedAt,
        updatedAt: endedAt,
      },
    });
    if (result.applied) {
      return true;
    }
    if (result.reason === "not_found" || !result.current) {
      return false;
    }
    current = result.current;
    if (!shouldFinalizeCancelledFlow(current)) {
      return false;
    }
  }
  return false;
}

function shouldRepairTerminalMirroredFlowTimestamp(flow: TaskFlowRecord): boolean {
  if (flow.syncMode !== "task_mirrored" || !isTerminalFlow(flow)) {
    return false;
  }
  if (flow.endedAt == null || flow.endedAt < flow.createdAt) {
    return false;
  }
  return flow.updatedAt > flow.endedAt;
}

function repairTerminalMirroredFlowTimestamp(flow: TaskFlowRecord): boolean {
  let current = flow;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!shouldRepairTerminalMirroredFlowTimestamp(current)) {
      return false;
    }
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: current.flowId,
      expectedRevision: current.revision,
      patch: {
        updatedAt: current.endedAt,
      },
    });
    if (result.applied) {
      return true;
    }
    if (result.reason === "not_found" || !result.current) {
      return false;
    }
    current = result.current;
  }
  return false;
}

export function getInspectableTaskFlowAuditSummary(): TaskFlowAuditSummary {
  return summarizeTaskFlowAuditFindings(listTaskFlowAuditFindings());
}

export function previewTaskFlowRegistryMaintenance(): TaskFlowRegistryMaintenanceSummary {
  const now = Date.now();
  let reconciled = 0;
  let pruned = 0;
  for (const flow of listTaskFlowRecords()) {
    if (shouldRepairTerminalMirroredFlowTimestamp(flow)) {
      reconciled += 1;
      continue;
    }
    if (shouldFinalizeCancelledFlow(flow)) {
      reconciled += 1;
      continue;
    }
    if (shouldPruneFlow(flow, now)) {
      pruned += 1;
    }
  }
  return { reconciled, pruned };
}

export async function runTaskFlowRegistryMaintenance(): Promise<TaskFlowRegistryMaintenanceSummary> {
  const now = Date.now();
  let reconciled = 0;
  let pruned = 0;
  for (const flow of listTaskFlowRecords()) {
    const current = getTaskFlowById(flow.flowId);
    if (!current) {
      continue;
    }
    if (shouldRepairTerminalMirroredFlowTimestamp(current)) {
      if (repairTerminalMirroredFlowTimestamp(current)) {
        reconciled += 1;
      }
      continue;
    }
    if (shouldFinalizeCancelledFlow(current)) {
      if (finalizeCancelledFlow(current, now)) {
        reconciled += 1;
      }
      continue;
    }
    if (shouldPruneFlow(current, now) && deleteTaskFlowRecordById(current.flowId)) {
      pruned += 1;
    }
  }
  return { reconciled, pruned };
}
