import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const SUBAGENT_TOOL_RECEIPTS_SYMBOL = Symbol.for("openclaw.subagentToolReceipts");
const RECEIPTS_PER_RUN_LIMIT = 20;

type JsonRecord = Record<string, unknown>;

export type SubagentToolReceipt = {
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
    recordedAt: params.now ?? Date.now(),
    ...(toolCallId ? { toolCallId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    toolResult: { card },
  };
  const receipts = state.byRunId.get(runId) ?? [];
  receipts.push(receipt);
  state.byRunId.set(runId, receipts.slice(-RECEIPTS_PER_RUN_LIMIT));
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
  return (state.byRunId.get(runId) ?? [])
    .filter((receipt) => !toolName || receipt.toolName === toolName)
    .map(cloneReceipt);
}

export function clearSubagentToolReceiptsForTests(): void {
  state.byRunId.clear();
}
