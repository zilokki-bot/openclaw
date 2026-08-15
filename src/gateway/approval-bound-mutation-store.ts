import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type {
  ApprovalBoundMutationBinding,
  ApprovalBoundMutationFinalizeResult,
  ApprovalBoundMutationReleaseResult,
  ApprovalBoundMutationReservation,
  ApprovalBoundMutationReserveResult,
} from "../plugins/runtime/runtime-approval-bound-mutation.types.js";
import type {
  ApprovalBoundMutations,
  DB as OpenClawStateKyselyDatabase,
  OperatorApprovals,
} from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

const DEFAULT_RESERVATION_TTL_MS = 30_000;
const DEFAULT_REDEMPTION_WINDOW_MS = 15 * 60_000;

type ApprovalMutationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "approval_bound_mutations" | "operator_approvals"
>;
type ApprovalMutationRow = Selectable<ApprovalBoundMutations>;
type OperatorApprovalRow = Selectable<OperatorApprovals>;

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function requireRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("expectedRevision must be a non-negative safe integer");
  }
  return value;
}

function requireDuration(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function normalizeBinding(pluginId: string, input: ApprovalBoundMutationBinding) {
  return {
    approvalId: requireTrimmed(input.approvalId, "approvalId"),
    pluginId: requireTrimmed(pluginId, "pluginId"),
    mutationId: requireTrimmed(input.mutationId, "mutationId"),
    resourceKind: requireTrimmed(input.resourceKind, "resourceKind"),
    resourceId: requireTrimmed(input.resourceId, "resourceId"),
    requester: {
      deviceId: input.requester.deviceId?.trim() || null,
      clientId: input.requester.clientId?.trim() || null,
      deviceTokenAuth: input.requester.deviceTokenAuth,
    },
    expectedRevision: requireRevision(input.expectedRevision),
  };
}

function rowMatchesBinding(
  row: ApprovalMutationRow,
  binding: ReturnType<typeof normalizeBinding>,
): boolean {
  return (
    row.approval_id === binding.approvalId &&
    row.plugin_id === binding.pluginId &&
    row.mutation_id === binding.mutationId &&
    row.resource_kind === binding.resourceKind &&
    row.resource_id === binding.resourceId &&
    row.requester_device_id === binding.requester.deviceId &&
    row.requester_client_id === binding.requester.clientId &&
    row.requester_device_token_auth === (binding.requester.deviceTokenAuth ? 1 : 0) &&
    row.expected_revision === binding.expectedRevision
  );
}

function decodeReservation(row: ApprovalMutationRow): ApprovalBoundMutationReservation {
  if (!row.approval_id) {
    throw new Error("approval mutation row is missing approval_id");
  }
  return {
    approvalId: row.approval_id,
    pluginId: row.plugin_id,
    mutationId: row.mutation_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    requester: {
      deviceId: row.requester_device_id,
      clientId: row.requester_client_id,
      deviceTokenAuth: row.requester_device_token_auth === 1,
    },
    expectedRevision: row.expected_revision,
    approvalExpiresAtMs: row.approval_expires_at_ms,
    reservedAtMs: row.reserved_at_ms,
    reservationExpiresAtMs: row.reservation_expires_at_ms,
    status: row.status as ApprovalBoundMutationReservation["status"],
    finalizedAtMs: row.finalized_at_ms,
    releasedAtMs: row.released_at_ms,
  };
}

function selectReservation(
  database: Parameters<Parameters<typeof runOpenClawStateWriteTransaction>[0]>[0],
  approvalId: string,
): ApprovalMutationRow | undefined {
  const stateDb = getNodeSqliteKysely<ApprovalMutationDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("approval_bound_mutations")
      .selectAll()
      .where("approval_id", "=", approvalId),
  );
}

function selectApproval(
  database: Parameters<Parameters<typeof runOpenClawStateWriteTransaction>[0]>[0],
  approvalId: string,
): OperatorApprovalRow | undefined {
  const stateDb = getNodeSqliteKysely<ApprovalMutationDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", approvalId),
  );
}

function assertApprovalAllowsBinding(params: {
  approval: OperatorApprovalRow | undefined;
  binding: ReturnType<typeof normalizeBinding>;
  nowMs: number;
  redemptionWindowMs: number;
}): OperatorApprovalRow {
  const { approval, binding, nowMs, redemptionWindowMs } = params;
  if (!approval) {
    throw new Error("approval not found");
  }
  if (
    approval.kind !== "plugin" ||
    approval.status !== "allowed" ||
    approval.decision !== "allow-once"
  ) {
    throw new Error("approval is not an allowed one-time plugin approval");
  }
  if (approval.consumed_at_ms !== null) {
    throw new Error("approval is already consumed");
  }
  if (approval.resolved_at_ms === null || approval.resolved_at_ms + redemptionWindowMs <= nowMs) {
    throw new Error("approval redemption window expired");
  }
  if (
    approval.requested_by_device_id !== binding.requester.deviceId ||
    approval.requested_by_client_id !== binding.requester.clientId ||
    approval.requested_by_device_token_auth !== (binding.requester.deviceTokenAuth ? 1 : 0)
  ) {
    throw new Error("approval requester does not match mutation requester");
  }
  const expectedBindingJson = JSON.stringify({
    pluginId: binding.pluginId,
    mutationId: binding.mutationId,
    resourceKind: binding.resourceKind,
    resourceId: binding.resourceId,
    expectedRevision: binding.expectedRevision,
  });
  if (approval.approval_mutation_binding_json !== expectedBindingJson) {
    throw new Error("operator approval does not carry this immutable mutation binding");
  }
  return approval;
}

function assertSameBinding(
  row: ApprovalMutationRow,
  binding: ReturnType<typeof normalizeBinding>,
): void {
  if (!rowMatchesBinding(row, binding)) {
    throw new Error("approval is bound to a different mutation, requester, resource, or revision");
  }
}

export function reserveApprovalBoundMutation(params: {
  pluginId: string;
  binding: ApprovalBoundMutationBinding;
  reservationTtlMs?: number;
  redemptionWindowMs?: number;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ApprovalBoundMutationReserveResult {
  const binding = normalizeBinding(params.pluginId, params.binding);
  const nowMs = params.nowMs ?? Date.now();
  const reservationTtlMs = requireDuration(
    params.reservationTtlMs,
    DEFAULT_RESERVATION_TTL_MS,
    "reservationTtlMs",
  );
  const redemptionWindowMs = requireDuration(
    params.redemptionWindowMs,
    DEFAULT_REDEMPTION_WINDOW_MS,
    "redemptionWindowMs",
  );
  return runOpenClawStateWriteTransaction((database) => {
    let row = selectReservation(database, binding.approvalId);
    if (!row) {
      throw new Error("approval has no immutable mutation binding from request time");
    }
    assertSameBinding(row, binding);
    if (row.status === "finalized") {
      return { outcome: "already-finalized", reservation: decodeReservation(row) };
    }
    const approval = assertApprovalAllowsBinding({
      approval: selectApproval(database, binding.approvalId),
      binding,
      nowMs,
      redemptionWindowMs,
    });
    if (row.approval_expires_at_ms !== approval.expires_at_ms) {
      throw new Error("approval mutation expiry does not match its operator approval");
    }
    const stateDb = getNodeSqliteKysely<ApprovalMutationDatabase>(database.db);
    if (row.status === "reserved" && row.reservation_expires_at_ms > nowMs) {
      return { outcome: "already-reserved", reservation: decodeReservation(row) };
    }
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("approval_bound_mutations")
        .set({
          status: "reserved",
          reserved_at_ms: nowMs,
          reservation_expires_at_ms: Math.min(
            approval.resolved_at_ms! + redemptionWindowMs,
            nowMs + reservationTtlMs,
          ),
          released_at_ms: null,
        })
        .where("approval_id", "=", binding.approvalId),
    );
    row = selectReservation(database, binding.approvalId);
    if (!row) {
      throw new Error("approval mutation reservation disappeared during recovery");
    }
    return { outcome: "reserved", reservation: decodeReservation(row) };
  }, params.databaseOptions);
}

export function finalizeApprovalBoundMutation(params: {
  pluginId: string;
  binding: ApprovalBoundMutationBinding;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ApprovalBoundMutationFinalizeResult {
  const binding = normalizeBinding(params.pluginId, params.binding);
  const nowMs = params.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const row = selectReservation(database, binding.approvalId);
    if (!row) {
      throw new Error("approval mutation is not reserved");
    }
    assertSameBinding(row, binding);
    if (row.status === "finalized") {
      return { outcome: "already-finalized", reservation: decodeReservation(row) };
    }
    if (row.status !== "reserved") {
      throw new Error("approval mutation is not reserved");
    }
    const approval = selectApproval(database, binding.approvalId);
    if (
      !approval ||
      approval.kind !== "plugin" ||
      approval.status !== "allowed" ||
      approval.decision !== "allow-once" ||
      approval.consumed_at_ms !== null ||
      approval.requested_by_device_id !== binding.requester.deviceId ||
      approval.requested_by_client_id !== binding.requester.clientId ||
      approval.requested_by_device_token_auth !== (binding.requester.deviceTokenAuth ? 1 : 0)
    ) {
      throw new Error("approval is missing, no longer allowed, mismatched, or already consumed");
    }
    const stateDb = getNodeSqliteKysely<ApprovalMutationDatabase>(database.db);
    const consumed = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({
          consumed_at_ms: nowMs,
          consumed_by: `${binding.pluginId}:${binding.mutationId}`,
          updated_at_ms: nowMs,
        })
        .where("approval_id", "=", binding.approvalId)
        .where("consumed_at_ms", "is", null),
    );
    if (consumed.numAffectedRows !== 1n) {
      throw new Error("approval mutation consume did not commit");
    }
    const finalizedMutation = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("approval_bound_mutations")
        .set({ status: "finalized", finalized_at_ms: nowMs, released_at_ms: null })
        .where("approval_id", "=", binding.approvalId)
        .where("status", "=", "reserved"),
    );
    if (finalizedMutation.numAffectedRows !== 1n) {
      throw new Error("approval mutation finalize did not commit");
    }
    const finalized = selectReservation(database, binding.approvalId);
    if (!finalized || finalized.status !== "finalized") {
      throw new Error("approval mutation finalize did not commit");
    }
    return { outcome: "finalized", reservation: decodeReservation(finalized) };
  }, params.databaseOptions);
}

export function releaseApprovalBoundMutation(params: {
  pluginId: string;
  binding: ApprovalBoundMutationBinding;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ApprovalBoundMutationReleaseResult {
  const binding = normalizeBinding(params.pluginId, params.binding);
  const nowMs = params.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const row = selectReservation(database, binding.approvalId);
    if (!row) {
      throw new Error("approval mutation is not reserved");
    }
    assertSameBinding(row, binding);
    if (row.status === "released") {
      return { outcome: "already-released", reservation: decodeReservation(row) };
    }
    if (row.status === "finalized") {
      throw new Error("finalized approval mutation cannot be released");
    }
    const stateDb = getNodeSqliteKysely<ApprovalMutationDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("approval_bound_mutations")
        .set({ status: "released", released_at_ms: nowMs })
        .where("approval_id", "=", binding.approvalId)
        .where("status", "=", "reserved"),
    );
    const released = selectReservation(database, binding.approvalId);
    if (!released || released.status !== "released") {
      throw new Error("approval mutation release did not commit");
    }
    return { outcome: "released", reservation: decodeReservation(released) };
  }, params.databaseOptions);
}
