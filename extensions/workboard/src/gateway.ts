// Workboard plugin module implements gateway behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { WorkboardMutationNotCommittedError } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";
import { WORKBOARD_STATUSES, type WorkboardCard } from "./types.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];

function respondError(respond: GatewayRespond, error: unknown) {
  respond(false, undefined, {
    code: "workboard_error",
    message: formatErrorMessage(error),
  });
}

function readId(params: Record<string, unknown>): string {
  const value = params.id;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error("id is required.");
}

function readPatch(params: Record<string, unknown>): Record<string, unknown> {
  const patch = params.patch;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return patch as Record<string, unknown>;
  }
  return params;
}

function readApprovalPatch(params: Record<string, unknown>): Record<string, unknown> {
  return readObjectParam(params, "patch");
}

function readObjectParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = params[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${key} is required.`);
}

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function readRequiredRevision(params: Record<string, unknown>): number {
  const value = params.expectedRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("expectedRevision must be a non-negative safe integer.");
  }
  return value;
}

function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = readOptionalString(params, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function assertNoSafeChildCreateEscapeHatches(params: Record<string, unknown>) {
  const agentId = readOptionalString(params, "agentId");
  if (agentId && agentId !== "workboard-worker") {
    throw new Error("safe child create only supports agentId=workboard-worker.");
  }
  if (readOptionalString(params, "cwd") || readOptionalString(params, "workspaceDir")) {
    throw new Error("safe child create does not accept caller-provided workspace paths.");
  }
}

function assertNoCursorAdvance(params: Record<string, unknown>) {
  if (params.advance === true) {
    throw new Error("notification cursor advancement requires workboard.notifications.advance.");
  }
}

function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: { ...claim, token: "[redacted]" },
    },
  };
}

function redactDiagnosticsRows(result: Awaited<ReturnType<WorkboardStore["diagnostics"]>>) {
  return {
    ...result,
    diagnostics: result.diagnostics.map((row) => ({
      ...row,
      card: redactClaimToken(row.card),
    })),
  };
}

type WorkboardDispatchResult = Awaited<ReturnType<typeof dispatchAndStartWorkboardCards>>;

const pendingDispatches = new Map<string, Promise<WorkboardDispatchResult>>();

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

async function argsHash(value: unknown): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function approvalMutationId(params: {
  cardId: string;
  expectedRevision: number;
  patch: Record<string, unknown>;
}): Promise<string> {
  return `workboard-card-update:${await argsHash(params)}`;
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

function readRestrictedWorkboardReceipt(receipts: unknown[]): {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolCallId?: string;
  toolResult: { card: { id: string; workspaceAccess: Record<string, unknown> } };
} {
  const restrictedReceipts: Array<{
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    toolCallId?: string;
    toolResult: { card: { id: string; workspaceAccess: Record<string, unknown> } };
  }> = [];

  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") {
      continue;
    }
    const record = receipt as Record<string, unknown>;
    const toolResult = record.toolResult as Record<string, unknown> | undefined;
    const card = toolResult?.card as Record<string, unknown> | undefined;
    const workspaceAccess = card?.workspaceAccess as Record<string, unknown> | undefined;
    if (
      typeof card?.id === "string" &&
      card.id.trim() &&
      workspaceAccess &&
      workspaceAccess.unrestricted === false
    ) {
      restrictedReceipts.push({
        ...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}),
        ...(typeof record.sessionKey === "string" ? { sessionKey: record.sessionKey } : {}),
        ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
        ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
        toolResult: {
          card: {
            id: card.id.trim(),
            workspaceAccess,
          },
        },
      });
    }
  }

  if (restrictedReceipts.length === 0) {
    throw new Error("safe child create did not return a restricted workboard_create receipt.");
  }
  if (restrictedReceipts.length > 1) {
    throw new Error("safe child create returned multiple restricted workboard_create receipts.");
  }
  return restrictedReceipts[0]!;
}

function buildSafeChildCreateTask(cardParams: Record<string, unknown>): string {
  return [
    "Call the workboard_create tool exactly once with the JSON arguments below.",
    "Do not call any other tool. After the tool call, reply with one short receipt sentence.",
    "",
    stableJson(cardParams),
  ].join("\n");
}

async function dispatchOnce(params: Parameters<typeof dispatchAndStartWorkboardCards>[0]) {
  // Key on the whole option set rather than a hand-picked subset. Every option
  // narrows what the dispatch may do (which board, how many starts, whether
  // managed worktrees are allowed), so two calls may only share a run when all
  // of them match. A subset key silently applies the first caller's bounds to a
  // second caller that asked for something different, and the omission is
  // invisible at the call site. stableJson sorts keys and drops undefined, so
  // callers passing the same options in a different order still coalesce.
  const key = stableJson(params.options ?? {});
  const pending = pendingDispatches.get(key);
  if (pending) {
    return pending;
  }
  const promise = dispatchAndStartWorkboardCards(params);
  pendingDispatches.set(key, promise);
  try {
    return await promise;
  } finally {
    if (pendingDispatches.get(key) === promise) {
      pendingDispatches.delete(key);
    }
  }
}

export function registerWorkboardGatewayMethods(params: {
  api: OpenClawPluginApi;
  store?: WorkboardStore;
}) {
  const { api } = params;
  const store = params.store ?? WorkboardStore.shared();

  api.registerGatewayMethod(
    "workboard.cards.list",
    async ({ params: requestParams, respond }) => {
      try {
        const includeArchived = readOptionalBoolean(requestParams, "includeArchived") === true;
        respond(true, {
          cards: (await store.list({ boardId: requestParams.boardId }))
            .filter((card) => includeArchived || !card.metadata?.archivedAt)
            .map(redactClaimToken),
          statuses: WORKBOARD_STATUSES,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.create",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, { card: redactClaimToken(await store.create(requestParams)) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

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
        // Recovery-by-receipt is checked BEFORE reserve(), which is expiry
        // sensitive. If the card write committed but finalize was interrupted,
        // a retry arriving after the redemption window must still replay and
        // finalize; reserving first would reject it as expired and leave the
        // approval permanently unfinalized. finalize() re-asserts the full
        // binding (pluginId/resourceKind/resourceId/requester/expectedRevision)
        // against the reservation row, so skipping reserve() here does not
        // weaken the binding check, and it never widens the plugin boundary.
        const existingReceipt = await store.lookupApprovalMutationReceipt(approvalId);
        if (existingReceipt) {
          // The card write is already durable. Never release a reservation if
          // recovery detects a corrupted/mismatched receipt; fail closed instead.
          // reservationMayBeReleased is still false here, so the catch block
          // below cannot release on any path from here on.
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
            // An unknown storage error can occur during or after COMMIT. Keep
            // the reservation for exact recovery instead of risking release
            // of an already-applied mutation.
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
            // Preserve the original failure. A missing or finalized reservation
            // is safe to leave for exact retry/recovery.
          }
        }
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.safeChildCreate",
    async ({ params: requestParams, respond }) => {
      try {
        assertNoSafeChildCreateEscapeHatches(requestParams);
        const cardParams = readObjectParam(requestParams, "card");
        const hash = await argsHash(cardParams);
        const sandboxPosture = {
          sandbox: "require",
          context: "isolated",
          mode: "run",
          cleanup: "keep",
          inheritedToolAllowlist: ["workboard_create"],
          singleRequest: true,
        };
        const spawn = await api.runtime.subagent.spawnSafe({
          task: buildSafeChildCreateTask(cardParams),
          taskName: readOptionalString(requestParams, "taskName") ?? "workboard-safe-child-create",
          label: readOptionalString(requestParams, "label") ?? "workboard safe child create",
          agentId: "workboard-worker",
          runTimeoutSeconds: 600,
          lightContext: true,
          expectsCompletionMessage: false,
        });
        if (spawn.status !== "accepted" || !spawn.runId || !spawn.childSessionKey) {
          throw new Error(spawn.error ?? "safe child create spawn was not accepted.");
        }
        const wait = await api.runtime.subagent.waitForRun({
          runId: spawn.runId,
          timeoutMs: 600_000,
        });
        if (wait.status !== "ok") {
          throw new Error(wait.error ?? `safe child create run ended with status ${wait.status}.`);
        }
        const receipt = readRestrictedWorkboardReceipt(
          (
            await api.runtime.subagent.getToolReceipts({
              runId: spawn.runId,
              toolName: "workboard_create",
            })
          ).receipts,
        );
        const cardId = receipt.toolResult.card.id;
        const readback = await store.get(cardId);
        const readbackAccess = readback?.metadata?.automation?.workspaceAccess;
        if (!readback || readbackAccess?.unrestricted !== false) {
          throw new Error(
            "safe child create Workboard readback did not confirm restricted access.",
          );
        }
        respond(true, {
          receipt: {
            taskId: spawn.runId,
            runId: spawn.runId,
            childSessionKey: spawn.childSessionKey,
            agentId: receipt.agentId ?? "workboard-worker",
            argsHash: hash,
            sandboxPosture,
            toolCallId: receipt.toolCallId,
            toolResult: receipt.toolResult,
            readback: {
              card: redactClaimToken(readback),
              workspaceAccess: readbackAccess,
            },
          },
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.update",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.update(readId(requestParams), readPatch(requestParams)),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.move",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.move(readId(requestParams), requestParams.status, requestParams.position),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.delete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.delete(readId(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.comment",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addComment(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.link",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addLink(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.linkDependency",
    async ({ params: requestParams, respond }) => {
      try {
        const parentId = requestParams.parentId;
        const childId = requestParams.childId;
        if (typeof parentId !== "string" || typeof childId !== "string") {
          throw new Error("parentId and childId are required.");
        }
        respond(true, {
          card: redactClaimToken(await store.linkCards(parentId, childId)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.proof",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addProof(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.artifact",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addArtifact(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.claim",
    async ({ params: requestParams, respond }) => {
      try {
        const claimed = await store.claim(readId(requestParams), requestParams);
        respond(true, { ...claimed, card: redactClaimToken(claimed.card) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.heartbeat",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.heartbeat(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.release",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.releaseClaim(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.promote",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.promote(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.reassign",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.reassign(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.reclaim",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.reclaim(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.complete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.complete(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.block",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.block(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.unblock",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.unblock(readId(requestParams))),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.bulk",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.bulkUpdate(requestParams);
        respond(true, { cards: result.cards.map(redactClaimToken) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.diagnostics",
    async ({ respond }) => {
      try {
        respond(true, redactDiagnosticsRows(await store.diagnostics()));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.diagnostics.refresh",
    async ({ respond }) => {
      try {
        respond(true, redactDiagnosticsRows(await store.refreshDiagnostics()));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.dispatch",
    async ({ params: requestParams, respond, client }) => {
      try {
        const boardId =
          requestParams && typeof requestParams === "object" && "boardId" in requestParams
            ? requestParams.boardId
            : undefined;
        const result = await dispatchOnce({
          store,
          subagent: api.runtime.subagent,
          worktrees: api.runtime.worktrees,
          options: {
            boardId: typeof boardId === "string" ? boardId : undefined,
            allowManagedWorktrees:
              Array.isArray(client?.connect?.scopes) &&
              client.connect.scopes.includes("operator.admin"),
          },
        });
        respond(true, {
          ...result,
          promoted: result.promoted.map(redactClaimToken),
          reclaimed: result.reclaimed.map(redactClaimToken),
          blocked: result.blocked.map(redactClaimToken),
          orchestrated: result.orchestrated.map(redactClaimToken),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.list",
    async ({ respond }) => {
      try {
        respond(true, await store.listBoards());
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.upsert",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, { board: await store.upsertBoard(requestParams) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.archive",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          board: await store.archiveBoard(requestParams.id, requestParams.archived),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.delete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.deleteBoard(requestParams.id));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.stats",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.stats({ boardId: requestParams.boardId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.runs",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.runs(readId(requestParams));
        respond(true, { ...result, card: redactClaimToken(result.card) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.specify",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.specify(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.decompose",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.decompose(readId(requestParams), requestParams, null);
        respond(true, {
          parent: redactClaimToken(result.parent),
          children: result.children.map(redactClaimToken),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.subscribe",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, { subscription: await store.subscribeNotifications(requestParams) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.list",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.listNotificationSubscriptions(requestParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.delete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.deleteNotificationSubscription(readId(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.events",
    async ({ params: requestParams, respond }) => {
      try {
        assertNoCursorAdvance(requestParams);
        respond(true, await store.notificationEvents(requestParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.advance",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.advanceNotificationEvents(requestParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.list",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.listAttachments(readId(requestParams));
        respond(true, { ...result, card: redactClaimToken(result.card) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.get",
    async ({ params: requestParams, respond }) => {
      try {
        const attachment = await store.getAttachment(readId(requestParams));
        if (!attachment) {
          throw new Error(`attachment not found: ${readId(requestParams)}`);
        }
        respond(true, attachment);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.add",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addAttachment(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.delete",
    async ({ params: requestParams, respond }) => {
      try {
        const attachmentId = requestParams.attachmentId;
        if (typeof attachmentId !== "string" || !attachmentId.trim()) {
          throw new Error("attachmentId is required.");
        }
        respond(true, {
          card: redactClaimToken(
            await store.deleteAttachment(readId(requestParams), attachmentId.trim()),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.workerLog",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addWorkerLog(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.protocolViolation",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.recordProtocolViolation(readId(requestParams), requestParams),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.archive",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.archive(readId(requestParams), requestParams.archived),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.export",
    async ({ respond }) => {
      try {
        const exported = await store.exportCards();
        respond(true, { ...exported, cards: exported.cards.map(redactClaimToken) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );
}
