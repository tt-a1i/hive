import type { Database } from './sqlite.js'

/**
 * Durable redelivery queue for protocol messages a live agent could not
 * receive. The primary producer is `team report`: it persists the dispatch as
 * reported and forwards the report into the orchestrator's stdin; if that write
 * fails (the PTY exited / is mid-restart, or the orchestrator was down at report
 * time) the report would otherwise be lost — the ledger says "reported" yet the
 * orchestrator waits forever, indistinguishable from a hang. Dispatch-drop
 * notifications use the same queue for their issuer.
 *
 * Entries are keyed by dispatch id (UNIQUE) so a report enqueues at most once,
 * and drain marks them delivered only after the target PTY write actually
 * resolves, so a failed redelivery stays pending for the next drain.
 */
export interface ReportOutboxEntry {
  id: number
  workspaceId: string
  targetAgentId: string
  dispatchId: string
  payload: string
  createdAt: number
  deliveredAt: number | null
}

interface EnqueueInput {
  workspaceId: string
  targetAgentId: string
  dispatchId: string
  payload: string
}

interface OutboxRow {
  id: number
  workspace_id: string
  target_agent_id: string
  dispatch_id: string
  payload: string
  created_at: number
  delivered_at: number | null
}

const rowToEntry = (row: OutboxRow): ReportOutboxEntry => ({
  id: row.id,
  workspaceId: row.workspace_id,
  targetAgentId: row.target_agent_id,
  dispatchId: row.dispatch_id,
  payload: row.payload,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
})

// Legacy external controllers mirrored dispatch messages into this outbox.
// Their canonical delivery and retirement are owned by dispatch_message_outbox.
// Use the stable receipt key so older databases need no optional metadata columns.
const internalReceiptSql = "dispatch_id NOT GLOB 'message:*'"

export const createReportOutboxStore = (db: Database) => {
  // INSERT OR IGNORE on the UNIQUE dispatch_id: a dispatch reports once, so a
  // second enqueue for the same dispatch (e.g. a retry path) is a no-op rather
  // than a duplicate the orchestrator would see twice.
  const enqueue = (input: EnqueueInput): void => {
    db.prepare(
      `INSERT OR IGNORE INTO report_outbox
        (workspace_id, target_agent_id, dispatch_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(input.workspaceId, input.targetAgentId, input.dispatchId, input.payload, Date.now())
  }

  const listPending = (workspaceId: string, targetAgentId: string): ReportOutboxEntry[] =>
    (
      db
        .prepare(
          `SELECT id, workspace_id, target_agent_id, dispatch_id, payload, created_at, delivered_at
           FROM report_outbox
           WHERE workspace_id = ? AND target_agent_id = ? AND delivered_at IS NULL AND ${internalReceiptSql}
           ORDER BY created_at ASC, id ASC`
        )
        .all(workspaceId, targetAgentId) as OutboxRow[]
    ).map(rowToEntry)

  const markDelivered = (id: number): void => {
    db.prepare(
      `UPDATE report_outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`
    ).run(Date.now(), id)
  }

  const deletePendingForDispatch = (dispatchId: string): void => {
    db.prepare('DELETE FROM report_outbox WHERE dispatch_id = ? AND delivered_at IS NULL').run(
      dispatchId
    )
  }

  const pendingCount = (workspaceId: string, targetAgentId: string): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM report_outbox
           WHERE workspace_id = ? AND target_agent_id = ? AND delivered_at IS NULL AND ${internalReceiptSql}`
        )
        .get(workspaceId, targetAgentId) as { n: number }
    ).n

  return {
    deletePendingForDispatch,
    enqueue,
    listPending,
    markDelivered,
    pendingCount,
  }
}

export type ReportOutboxStore = ReturnType<typeof createReportOutboxStore>
