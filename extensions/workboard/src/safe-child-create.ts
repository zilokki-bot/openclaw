import type { WorkboardCard } from "@openclaw/workboard-contract";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardStore } from "./store.js";

type SafeSubagentRuntime = {
  spawnSafe(params: {
    task: string;
    taskName: string;
    label: string;
    agentId: string;
    runTimeoutSeconds: number;
    lightContext: boolean;
    expectsCompletionMessage: boolean;
  }): Promise<{
    status: string;
    runId?: string;
    childSessionKey?: string;
    error?: string;
  }>;
  waitForRun(params: { runId: string; timeoutMs: number }): Promise<{
    status: string;
    error?: string;
  }>;
  getToolReceipts(params: { runId: string; toolName: string }): Promise<{ receipts: unknown[] }>;
};

type SafeChildCreateReceipt = {
  receipt: {
    taskId: string;
    runId: string;
    childSessionKey: string;
    agentId: string;
    argsHash: string;
    sandboxPosture: {
      sandbox: "require";
      context: "isolated";
      mode: "run";
      cleanup: "keep";
      inheritedToolAllowlist: ["workboard_create"];
      singleRequest: true;
    };
    toolCallId?: string;
    toolResult: { card: { id: string; workspaceAccess: Record<string, unknown> } };
    readback: {
      card: WorkboardCard;
      workspaceAccess: unknown;
    };
  };
};

export function readObjectParam(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = params[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${key} is required.`);
}

export function readOptionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function assertNoSafeChildCreateEscapeHatches(params: Record<string, unknown>) {
  const agentId = readOptionalString(params, "agentId");
  if (agentId && agentId !== "workboard-worker") {
    throw new Error("safe child create only supports agentId=workboard-worker.");
  }
  if (readOptionalString(params, "cwd") || readOptionalString(params, "workspaceDir")) {
    throw new Error("safe child create does not accept caller-provided workspace paths.");
  }
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

async function argsHash(value: unknown): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(stableJson(value)).digest("hex");
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

function readIdempotencyScope(cardParams: Record<string, unknown>):
  | {
      idempotencyKey: string;
      tenant?: string;
      boardId: string;
    }
  | undefined {
  const idempotencyKey = readOptionalString(cardParams, "idempotencyKey");
  if (!idempotencyKey) {
    return undefined;
  }
  return {
    idempotencyKey,
    ...(readOptionalString(cardParams, "tenant")
      ? { tenant: readOptionalString(cardParams, "tenant") }
      : {}),
    boardId: readOptionalString(cardParams, "boardId") ?? "default",
  };
}

async function assertNoExistingUnrestrictedSameKey(params: {
  store: WorkboardStore;
  cardParams: Record<string, unknown>;
}) {
  const scope = readIdempotencyScope(params.cardParams);
  if (!scope) {
    return;
  }
  const existing = (await params.store.list({ boardId: scope.boardId })).find(
    (card) =>
      card.metadata?.automation?.idempotencyKey === scope.idempotencyKey &&
      card.metadata?.automation?.tenant === scope.tenant &&
      cardBoardId(card) === scope.boardId,
  );
  if (existing?.metadata?.automation?.workspaceAccess?.unrestricted === true) {
    throw new Error(
      `safe child create blocked: existing same-key Workboard card ${existing.id} has unrestricted workspace access; remediate or explicitly adopt it before retrying.`,
    );
  }
}

export async function executeWorkboardSafeChildCreate(params: {
  runtime: SafeSubagentRuntime;
  store: WorkboardStore;
  cardParams: Record<string, unknown>;
  taskName?: string;
  label?: string;
  redactCard: (card: WorkboardCard) => WorkboardCard;
}): Promise<SafeChildCreateReceipt> {
  await assertNoExistingUnrestrictedSameKey({
    store: params.store,
    cardParams: params.cardParams,
  });
  const hash = await argsHash(params.cardParams);
  const sandboxPosture = {
    sandbox: "require" as const,
    context: "isolated" as const,
    mode: "run" as const,
    cleanup: "keep" as const,
    inheritedToolAllowlist: ["workboard_create"] as ["workboard_create"],
    singleRequest: true as const,
  };
  const spawn = await params.runtime.spawnSafe({
    task: buildSafeChildCreateTask(params.cardParams),
    taskName: params.taskName ?? "workboard-safe-child-create",
    label: params.label ?? "workboard safe child create",
    agentId: "workboard-worker",
    runTimeoutSeconds: 600,
    lightContext: true,
    expectsCompletionMessage: false,
  });
  if (spawn.status !== "accepted" || !spawn.runId || !spawn.childSessionKey) {
    throw new Error(spawn.error ?? "safe child create spawn was not accepted.");
  }
  const wait = await params.runtime.waitForRun({
    runId: spawn.runId,
    timeoutMs: 600_000,
  });
  if (wait.status !== "ok") {
    throw new Error(wait.error ?? `safe child create run ended with status ${wait.status}.`);
  }
  const receipt = readRestrictedWorkboardReceipt(
    (
      await params.runtime.getToolReceipts({
        runId: spawn.runId,
        toolName: "workboard_create",
      })
    ).receipts,
  );
  const cardId = receipt.toolResult.card.id;
  const readback = await params.store.get(cardId);
  const readbackAccess = readback?.metadata?.automation?.workspaceAccess;
  if (!readback || readbackAccess?.unrestricted !== false) {
    throw new Error("safe child create Workboard readback did not confirm restricted access.");
  }
  return {
    receipt: {
      taskId: spawn.runId,
      runId: spawn.runId,
      childSessionKey: spawn.childSessionKey,
      agentId: receipt.agentId ?? "workboard-worker",
      argsHash: hash,
      sandboxPosture,
      ...(receipt.toolCallId ? { toolCallId: receipt.toolCallId } : {}),
      toolResult: receipt.toolResult,
      readback: {
        card: params.redactCard(readback),
        workspaceAccess: readbackAccess,
      },
    },
  };
}
