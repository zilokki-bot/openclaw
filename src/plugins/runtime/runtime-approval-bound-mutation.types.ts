export type ApprovalBoundMutationRequester = {
  deviceId: string | null;
  clientId: string | null;
  deviceTokenAuth: boolean;
};

export type ApprovalBoundMutationBinding = {
  approvalId: string;
  mutationId: string;
  resourceKind: string;
  resourceId: string;
  requester: ApprovalBoundMutationRequester;
  expectedRevision: number;
};

export type ApprovalBoundMutationReservation = ApprovalBoundMutationBinding & {
  pluginId: string;
  approvalExpiresAtMs: number;
  reservedAtMs: number;
  reservationExpiresAtMs: number;
  status: "reserved" | "finalized" | "released";
  finalizedAtMs: number | null;
  releasedAtMs: number | null;
};

export type ApprovalBoundMutationReserveResult =
  | { outcome: "reserved" | "already-reserved"; reservation: ApprovalBoundMutationReservation }
  | { outcome: "already-finalized"; reservation: ApprovalBoundMutationReservation };

export type ApprovalBoundMutationFinalizeResult = {
  outcome: "finalized" | "already-finalized";
  reservation: ApprovalBoundMutationReservation;
};

export type ApprovalBoundMutationReleaseResult = {
  outcome: "released" | "already-released";
  reservation: ApprovalBoundMutationReservation;
};

export type PluginRuntimeApprovalBoundMutation = {
  request: (params: {
    mutationId: string;
    resourceKind: string;
    resourceId: string;
    expectedRevision: number;
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    toolName?: string;
    toolCallId?: string;
    agentId?: string;
    sessionKey?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  reserve: (
    params: ApprovalBoundMutationBinding & {
      reservationTtlMs?: number;
      redemptionWindowMs?: number;
      nowMs?: number;
    },
  ) => ApprovalBoundMutationReserveResult;
  finalize: (
    params: ApprovalBoundMutationBinding & { nowMs?: number },
  ) => ApprovalBoundMutationFinalizeResult;
  release: (
    params: ApprovalBoundMutationBinding & { nowMs?: number },
  ) => ApprovalBoundMutationReleaseResult;
};
