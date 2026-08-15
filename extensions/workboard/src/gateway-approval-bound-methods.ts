import type { OpenClawPluginApi } from "../api.js";
import { redactClaimToken } from "./card-redaction.js";
import { readId, respondError } from "./gateway-helpers.js";
import { WorkboardMutationNotCommittedError } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

const WRITE_SCOPE = "operator.write" as const;

function readApprovalPatch(params: Record<string, unknown>): Record<string, unknown> {
  const patch = params.patch;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return patch as Record<string, unknown>;
  }
  throw new Error("patch is required.");
}

function readRequiredRevision(params: Record<string, unknown>): number {
  const value = params.expectedRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("expectedRevision must be a non-negative safe integer.");
  }
  return value;
}

function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`${key} is required.`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function approvalMutationId(params: {
  cardId: string;
  expectedRevision: number;
  patch: Record<string, unknown>;
}): Promise<string> {
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(stableJson(params)).digest("hex");
  return `workboard-card-update:${digest}`;
}

function receiptMatchesApprovalBinding(
  receipt: Awaited<ReturnType<WorkboardStore["lookupApprovalMutationReceipt"]>>,
  binding: {
    approvalId: string;
    mutationId: string;
    cardId: string;
    requesterDeviceId: string | null;
    requesterClientId: string | null;
    requesterDeviceTokenAuth: boolean;
    expectedRevision: number;
  },
): boolean {
  return Boolean(
    receipt &&
    receipt.approvalId === binding.approvalId &&
    receipt.mutationId === binding.mutationId &&
    receipt.cardId === binding.cardId &&
    receipt.requesterDeviceId === binding.requesterDeviceId &&
    receipt.requesterClientId === binding.requesterClientId &&
    receipt.requesterDeviceTokenAuth === binding.requesterDeviceTokenAuth &&
    receipt.oldRevision === binding.expectedRevision &&
    receipt.newRevision === binding.expectedRevision + 1,
  );
}

export function registerWorkboardApprovalBoundMethods(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
}): void {
  const { api, store } = params;
  api.registerGatewayMethod(
    "workboard.cards.approvalBoundRequest",
    async ({ params: requestParams, respond }) => {
      try {
        const id = readId(requestParams);
        const expectedRevision = readRequiredRevision(requestParams);
        const patch = readApprovalPatch(requestParams);
        const card = await store.get(id);
        if (!card) {
          throw new Error(`card not found: ${id}`);
        }
        if ((card.revision ?? 0) !== expectedRevision) {
          throw new Error(
            `workboard revision conflict: expected ${expectedRevision}, current ${card.revision ?? 0}`,
          );
        }
        const mutationId = await approvalMutationId({ cardId: id, expectedRevision, patch });
        const changedFields = (Object.keys(patch).toSorted().join(", ") || "(none)").slice(0, 160);
        const approval = await api.runtime.approvalBoundMutation.request({
          mutationId,
          resourceKind: "workboard-card",
          resourceId: id,
          expectedRevision,
          title: "Update Workboard card",
          description: `Apply exact Workboard update: card=${id}; revision=${expectedRevision}; fields=${changedFields}; mutation=${mutationId}.`,
          severity: "warning",
          toolName: "workboard.cards.approvalBoundUpdate",
          timeoutMs:
            typeof requestParams.timeoutMs === "number" ? requestParams.timeoutMs : undefined,
        });
        respond(true, { approval, mutationId });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.approvalBoundUpdate",
    async ({ params: requestParams, client, respond }) => {
      const id = readId(requestParams);
      const approvalId = readRequiredString(requestParams, "approvalId");
      const expectedRevision = readRequiredRevision(requestParams);
      const patch = readApprovalPatch(requestParams);
      const mutationId = await approvalMutationId({ cardId: id, expectedRevision, patch });
      const requester = {
        deviceId: client?.connect.device?.id?.trim() || null,
        clientId: client?.connect.client.id?.trim() || null,
        deviceTokenAuth: client?.isDeviceTokenAuth === true,
      };
      const binding = {
        approvalId,
        mutationId,
        resourceKind: "workboard-card",
        resourceId: id,
        requester,
        expectedRevision,
      };
      let cardCommitted = false;
      let reservationMayBeReleased = false;
      try {
        // Recovery-by-receipt must run before the expiry-sensitive reserve.
        // finalize() reasserts the complete immutable binding against the durable row.
        const existingReceipt = await store.lookupApprovalMutationReceipt(approvalId);
        if (existingReceipt) {
          cardCommitted = true;
          if (
            !receiptMatchesApprovalBinding(existingReceipt, {
              approvalId,
              mutationId,
              cardId: id,
              requesterDeviceId: requester.deviceId,
              requesterClientId: requester.clientId,
              requesterDeviceTokenAuth: requester.deviceTokenAuth,
              expectedRevision,
            })
          ) {
            throw new Error("approval mutation receipt does not match this request.");
          }
          const card = await store.get(id);
          if (!card || (card.revision ?? 0) < existingReceipt.newRevision) {
            throw new Error("approval mutation receipt is ahead of the current card revision.");
          }
          api.runtime.approvalBoundMutation.finalize(binding);
          respond(true, { card: redactClaimToken(card), receipt: existingReceipt, replayed: true });
          return;
        }
        const reservation = api.runtime.approvalBoundMutation.reserve(binding);
        if (reservation.outcome === "already-finalized") {
          throw new Error("finalized approval mutation is missing its Workboard receipt.");
        }
        reservationMayBeReleased = true;
        let updated: Awaited<ReturnType<WorkboardStore["updateIfRevision"]>>;
        try {
          updated = await store.updateIfRevision({
            id,
            expectedRevision,
            patch,
            receipt: {
              approvalId,
              mutationId,
              requesterDeviceId: requester.deviceId,
              requesterClientId: requester.clientId,
              requesterDeviceTokenAuth: requester.deviceTokenAuth,
              createdAt: Date.now(),
            },
          });
        } catch (error) {
          if (!(error instanceof WorkboardMutationNotCommittedError)) {
            reservationMayBeReleased = false;
          }
          throw error;
        }
        cardCommitted = true;
        reservationMayBeReleased = false;
        api.runtime.approvalBoundMutation.finalize(binding);
        respond(true, {
          card: redactClaimToken(updated.card),
          receipt: updated.receipt,
          replayed: updated.replayed,
        });
      } catch (error) {
        if (!cardCommitted && reservationMayBeReleased) {
          try {
            api.runtime.approvalBoundMutation.release(binding);
          } catch {
            // Preserve the original error and leave an uncertain reservation for exact recovery.
          }
        }
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}
