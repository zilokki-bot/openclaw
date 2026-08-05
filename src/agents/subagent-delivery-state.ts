import { normalizeAgentRunTerminalReplySnapshot } from "./agent-run-terminal-reply.js";
import type {
  SubagentCompletionDeliveryState,
  SubagentCompletionState,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export function normalizeSubagentRunState(entry: SubagentRunRecord): SubagentRunRecord {
  const taskRunId = typeof entry.taskRunId === "string" ? entry.taskRunId.trim() : "";
  entry.taskRunId = taskRunId || undefined;
  const requesterTurnRunId =
    typeof entry.requesterTurnRunId === "string" ? entry.requesterTurnRunId.trim() : "";
  entry.requesterTurnRunId = requesterTurnRunId || undefined;
  entry.requesterTurnYielded =
    requesterTurnRunId && entry.requesterTurnYielded === true ? true : undefined;
  entry.retireAfterRequesterTurn =
    requesterTurnRunId && entry.retireAfterRequesterTurn === true ? true : undefined;
  entry.generation =
    typeof entry.generation === "number" &&
    Number.isSafeInteger(entry.generation) &&
    entry.generation > 0
      ? entry.generation
      : undefined;
  entry.deleteCleanupDispatchedAt = Number.isFinite(entry.deleteCleanupDispatchedAt)
    ? entry.deleteCleanupDispatchedAt
    : undefined;
  entry.suppressCompletionDelivery = entry.suppressCompletionDelivery === true ? true : undefined;
  entry.terminalOwner =
    entry.terminalOwner === "interrupted-recovery" &&
    Number.isFinite(entry.execution.endedAt) &&
    entry.execution.outcome?.status === "error" &&
    entry.endedReason === "subagent-error" &&
    entry.pauseReason !== "sessions_yield"
      ? "interrupted-recovery"
      : undefined;
  if (entry.completion) {
    entry.completion.terminalReply = normalizeAgentRunTerminalReplySnapshot(
      entry.completion.terminalReply,
    );
  }
  const killReconciliation = entry.killReconciliation;
  if (
    !killReconciliation ||
    typeof killReconciliation !== "object" ||
    !Number.isFinite(killReconciliation.killedAt)
  ) {
    delete entry.killReconciliation;
  } else {
    entry.killReconciliation = {
      killedAt: killReconciliation.killedAt,
      suppressTaskDelivery: killReconciliation.suppressTaskDelivery === true ? true : undefined,
      supersededAt: Number.isFinite(killReconciliation.supersededAt)
        ? killReconciliation.supersededAt
        : undefined,
    };
  }
  const killIntent = entry.killIntent;
  if (
    !killIntent ||
    typeof killIntent !== "object" ||
    !Number.isFinite(killIntent.requestedAt) ||
    typeof killIntent.reason !== "string" ||
    !killIntent.reason.trim()
  ) {
    delete entry.killIntent;
  } else {
    entry.killIntent = {
      requestedAt: killIntent.requestedAt,
      reason: killIntent.reason.trim(),
      lifecycleGeneration:
        typeof killIntent.lifecycleGeneration === "string" && killIntent.lifecycleGeneration.trim()
          ? killIntent.lifecycleGeneration.trim()
          : undefined,
      sessionId:
        typeof killIntent.sessionId === "string" && killIntent.sessionId.trim()
          ? killIntent.sessionId.trim()
          : undefined,
      sessionLifecycleRevision:
        typeof killIntent.sessionLifecycleRevision === "string" &&
        killIntent.sessionLifecycleRevision.trim()
          ? killIntent.sessionLifecycleRevision.trim()
          : undefined,
      suppressTaskDelivery: killIntent.suppressTaskDelivery === true ? true : undefined,
    };
  }
  // cleanupHandled is an in-process lock; after restart, unfinished cleanup must
  // retry unless durable cleanup completion was recorded.
  if (
    entry.cleanupHandled === true &&
    typeof entry.cleanupCompletedAt !== "number" &&
    entry.delivery?.status !== "discarded"
  ) {
    entry.cleanupHandled = false;
  }
  return entry;
}

/** Ensures a run has a nested completion state object. */
export function ensureCompletionState(entry: SubagentRunRecord): SubagentCompletionState {
  entry.completion ??= {
    required: entry.expectsCompletionMessage === true,
  };
  return entry.completion;
}

/** Ensures a run has a nested delivery state object. */
export function ensureDeliveryState(entry: SubagentRunRecord): SubagentCompletionDeliveryState {
  entry.delivery ??= {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
  return entry.delivery;
}

/** Resets delivery state to its initial status for the run's completion requirement. */
export function clearDeliveryState(entry: SubagentRunRecord): void {
  entry.delivery = {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
}

/** Returns true when delivery is suspended with a durable timestamp. */
export function isDeliverySuspended(entry: Pick<SubagentRunRecord, "delivery">): boolean {
  return entry.delivery?.status === "suspended" && typeof entry.delivery.suspendedAt === "number";
}

/**
 * Re-arms a suspended final delivery so the announce path stops skipping it.
 *
 * Suspension keeps the frozen payload — the completion text the requester never
 * received — but every automatic path returns early on a suspended entry, so a
 * finished result sits unreachable until it expires and is pruned. There is no
 * other way back: the only transition to `pending` is the retry that runs
 * *before* suspension. Resuming clears the suspension and the spent attempt
 * budget and leaves `payload` untouched, which is the whole point: the answer is
 * already stored, only its delivery stopped.
 *
 * Returns false when the entry was not suspended, so a caller can report
 * "nothing to resume" instead of reporting success for a no-op.
 */
export function resumeSuspendedDelivery(entry: SubagentRunRecord): boolean {
  if (!isDeliverySuspended(entry)) {
    return false;
  }
  const delivery = ensureDeliveryState(entry);
  delivery.status = "pending";
  delivery.suspendedAt = undefined;
  delivery.suspendedReason = undefined;
  delivery.attemptCount = 0;
  delivery.lastError = null;
  return true;
}

/** Reads the current delivery attempt count. */
export function getDeliveryAttemptCount(entry: SubagentRunRecord): number {
  return entry.delivery?.attemptCount ?? 0;
}

/** Reads the non-empty last delivery error. */
export function getDeliveryLastError(entry: SubagentRunRecord): string | undefined {
  const error = entry.delivery?.lastError;
  return typeof error === "string" && error.trim() ? error : undefined;
}
