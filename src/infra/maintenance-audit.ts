// Writes one metadata-only audit row for an explicitly applied local maintenance operation.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** No payload, error text, message body, task goal, or individual ID is written here. */
export function appendLocalMaintenanceAudit(params: {
  db: DatabaseSync;
  action: "taskflow_orphaned_queued" | "channel_ingress_failed_prune" | "outbound_failed_prune";
  occurredAt: number;
  resultCount: number;
}): string {
  const eventId = randomUUID();
  params.db
    .prepare(
      `INSERT INTO audit_events (
        event_id, source_id, schema_version, source_sequence, occurred_at,
        kind, action, status, actor_type, actor_id, result_count
      ) VALUES (?, ?, 1, 1, ?, 'maintenance', ?, 'succeeded', 'local_cli', 'operator', ?)`,
    )
    .run(eventId, `maintenance:${eventId}`, params.occurredAt, params.action, params.resultCount);
  return eventId;
}
