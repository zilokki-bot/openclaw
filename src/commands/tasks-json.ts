// JSON-only task command helpers.
// These paths avoid maintenance reconciliation so short-lived JSON CLI processes stay read-only and exit cleanly.

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { listTaskRecords, listTaskRecordsPage } from "../tasks/runtime-internal.js";
import { listTaskFlowAuditFindings } from "../tasks/task-flow-registry.audit.js";
import { listTaskAuditFindings } from "../tasks/task-registry.audit.js";
import type { TaskRecord, TaskRuntime, TaskStatus } from "../tasks/task-registry.types.js";
import {
  buildTaskSystemAuditJsonPayload,
  buildTaskSystemAuditFindings,
  type TaskSystemAuditCode,
  type TaskSystemAuditSeverity,
} from "./tasks-audit-system.js";

const DEFAULT_TASKS_LIST_JSON_LIMIT = 500;
const MAX_TASKS_LIST_JSON_LIMIT = 500;
const TASK_RUNTIMES = new Set<TaskRuntime>(["subagent", "acp", "cli", "cron"]);
const TASK_STATUSES = new Set<TaskStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
]);

function parseCursor(cursor: string | undefined): number | null {
  if (!cursor) {
    return 0;
  }
  if (!/^\d+$/.test(cursor.trim())) {
    return null;
  }
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function listTaskJsonRecords(opts?: {
  runtime?: TaskRuntime;
  status?: TaskStatus;
  limit?: number;
  cursor?: number;
}): { tasks: TaskRecord[]; nextCursor?: string } {
  // Keep the routed JSON path a read-only store snapshot; maintenance reconciliation imports
  // broader task runtimes and can keep JSON-only CLI processes alive.
  return listTaskRecordsPage({
    ...(opts?.runtime ? { runtime: opts.runtime } : {}),
    ...(opts?.status ? { statuses: [opts.status] } : {}),
    limit: Math.min(opts?.limit ?? DEFAULT_TASKS_LIST_JSON_LIMIT, MAX_TASKS_LIST_JSON_LIMIT),
    cursor: opts?.cursor ?? 0,
  });
}

type TasksListJsonArgs = {
  json?: boolean;
  runtime?: string;
  status?: string;
  limit?: number;
  cursor?: string;
};

type TasksAuditJsonArgs = {
  json?: boolean;
  severity?: string;
  code?: string;
  limit?: number;
};

function toSystemAuditFindings(params: {
  severityFilter?: TaskSystemAuditSeverity;
  codeFilter?: TaskSystemAuditCode;
}) {
  const tasks = listTaskRecords();
  const taskFindings = listTaskAuditFindings({ tasks });
  const flowFindings = listTaskFlowAuditFindings();
  const result = buildTaskSystemAuditFindings({
    taskFindings,
    flowFindings,
    severityFilter: params.severityFilter,
    codeFilter: params.codeFilter,
  });
  return result;
}

function buildTasksListJsonPayload(opts: TasksListJsonArgs) {
  const runtimeFilter = normalizeOptionalString(opts.runtime);
  const statusFilter = normalizeOptionalString(opts.status);
  const runtime =
    runtimeFilter && TASK_RUNTIMES.has(runtimeFilter as TaskRuntime)
      ? (runtimeFilter as TaskRuntime)
      : undefined;
  const status =
    statusFilter && TASK_STATUSES.has(statusFilter as TaskStatus)
      ? (statusFilter as TaskStatus)
      : undefined;
  const cursor = parseCursor(opts.cursor);
  const page =
    (runtimeFilter && !runtime) || (statusFilter && !status) || cursor === null
      ? { tasks: [] }
      : listTaskJsonRecords({ runtime, status, limit: opts.limit, cursor });
  const tasks = page.tasks;
  return {
    count: tasks.length,
    runtime: runtimeFilter ?? null,
    status: statusFilter ?? null,
    tasks,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

function buildTasksAuditJsonPayload(opts: TasksAuditJsonArgs) {
  const severityFilter = normalizeOptionalString(opts.severity) as
    | TaskSystemAuditSeverity
    | undefined;
  const codeFilter = normalizeOptionalString(opts.code) as TaskSystemAuditCode | undefined;
  const result = toSystemAuditFindings({
    severityFilter,
    codeFilter,
  });
  return buildTaskSystemAuditJsonPayload(result, {
    severityFilter,
    codeFilter,
    limit: opts.limit,
  });
}

/** Writes task list JSON without triggering task maintenance. */
export async function tasksListJsonCommand(
  opts: TasksListJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksListJsonPayload(opts));
}

/** Writes task audit JSON with combined task/task-flow findings. */
export async function tasksAuditJsonCommand(
  opts: TasksAuditJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksAuditJsonPayload(opts));
}
