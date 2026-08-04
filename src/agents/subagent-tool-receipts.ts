import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const SUBAGENT_TOOL_RECEIPTS_SYMBOL = Symbol.for("openclaw.subagentToolReceipts");
const RECEIPTS_PER_RUN_LIMIT = 20;
const RECEIPT_RUN_LIMIT = 512;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

type SubagentToolReceipt = {
  runId: string;
  toolName: "workboard_create";
  recordedAt: number;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolResult: {
    card: {
      id: string;
      workspaceAccess: JsonRecord;
    };
  };
};

type SubagentToolReceiptsState = {
  byRunId: Map<string, SubagentToolReceipt[]>;
};

const state = resolveGlobalSingleton<SubagentToolReceiptsState>(
  SUBAGENT_TOOL_RECEIPTS_SYMBOL,
  () => ({ byRunId: new Map() }),
);

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function cloneReceipt(receipt: SubagentToolReceipt): SubagentToolReceipt {
  return {
    ...receipt,
    toolResult: {
      card: {
        id: receipt.toolResult.card.id,
        workspaceAccess: { ...receipt.toolResult.card.workspaceAccess },
      },
    },
  };
}

function extractSafeWorkboardCreateCard(result: unknown):
  | {
      id: string;
      workspaceAccess: JsonRecord;
    }
  | undefined {
  const details = asRecord(asRecord(result)?.details);
  const card = asRecord(details?.card);
  const id = normalizeOptionalString(card?.id);
  const metadata = asRecord(card?.metadata);
  const automation = asRecord(metadata?.automation);
  const workspaceAccess = asRecord(automation?.workspaceAccess);
  if (!id || workspaceAccess?.unrestricted !== false) {
    return undefined;
  }
  return { id, workspaceAccess: { ...workspaceAccess } };
}

function pruneReceiptState(now: number): void {
  const expiresBefore = now - RECEIPT_TTL_MS;
  for (const [runId, receipts] of state.byRunId) {
    const freshReceipts = receipts.filter((receipt) => receipt.recordedAt >= expiresBefore);
    if (freshReceipts.length === 0) {
      state.byRunId.delete(runId);
      continue;
    }
    if (freshReceipts.length !== receipts.length) {
      state.byRunId.set(runId, freshReceipts);
    }
  }

  while (state.byRunId.size > RECEIPT_RUN_LIMIT) {
    let oldestRunId: string | undefined;
    let oldestRecordedAt = Number.POSITIVE_INFINITY;
    for (const [runId, receipts] of state.byRunId) {
      const newestReceipt = receipts[receipts.length - 1];
      const recordedAt = newestReceipt?.recordedAt ?? 0;
      if (recordedAt < oldestRecordedAt) {
        oldestRunId = runId;
        oldestRecordedAt = recordedAt;
      }
    }
    if (!oldestRunId) {
      return;
    }
    state.byRunId.delete(oldestRunId);
  }
}

export function recordSubagentToolReceipt(params: {
  runId?: string;
  toolName: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  result: unknown;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  pruneReceiptState(now);
  const runId = normalizeOptionalString(params.runId);
  const toolName = normalizeOptionalString(params.toolName);
  if (!runId || toolName !== "workboard_create") {
    return;
  }
  const card = extractSafeWorkboardCreateCard(params.result);
  if (!card) {
    return;
  }
  const toolCallId = normalizeOptionalString(params.toolCallId);
  const agentId = normalizeOptionalString(params.agentId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  const receipt: SubagentToolReceipt = {
    runId,
    toolName: "workboard_create",
    recordedAt: now,
    ...(toolCallId ? { toolCallId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    toolResult: { card },
  };
  const receipts = state.byRunId.get(runId) ?? [];
  receipts.push(receipt);
  state.byRunId.set(runId, receipts.slice(-RECEIPTS_PER_RUN_LIMIT));
  pruneReceiptState(now);
}

export function listSubagentToolReceipts(params: {
  runId: string;
  toolName?: string;
}): SubagentToolReceipt[] {
  const runId = normalizeOptionalString(params.runId);
  const toolName = normalizeOptionalString(params.toolName);
  if (!runId) {
    return [];
  }
  pruneReceiptState(Date.now());
  return (state.byRunId.get(runId) ?? [])
    .filter((receipt) => !toolName || receipt.toolName === toolName)
    .map(cloneReceipt);
}
