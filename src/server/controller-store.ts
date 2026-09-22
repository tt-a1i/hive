import { randomUUID } from 'node:crypto'
import { controllerReceiptPendingSql } from './controller-receipt-policy.js'
import { serializeDispatchMessage } from './dispatch-message-serializer.js'
import { readDispatchMessage } from './dispatch-message-store.js'
import { ConflictError, ForbiddenError } from './http-errors.js'
import type { Database } from './sqlite.js'

export interface ControllerRow {
  workspace_id: string
  thread_id: string | null
  request_id: string | null
  request_thread_id: string | null
  connection_error: string | null
}
export interface ControllerReport {
  outcome: 'success' | 'failed' | null
  id: number
  dispatch_id: string
  worker_name: string
  status: string
  kind: string
  result: string | null
  artifacts: string[]
  message?: ReturnType<typeof serializeDispatchMessage>
}

export const createControllerStore = (db: Database) => {
  const get = (workspaceId: string): ControllerRow => {
    db.prepare('INSERT OR IGNORE INTO workspace_controllers(workspace_id) VALUES (?)').run(
      workspaceId
    )
    return db
      .prepare('SELECT * FROM workspace_controllers WHERE workspace_id = ?')
      .get(workspaceId) as ControllerRow
  }
  const requireThread = (workspaceId: string, threadId: string) => {
    const binding = get(workspaceId)
    if (binding.thread_id !== threadId)
      throw new ForbiddenError('This Codex App task is not the confirmed workspace controller')
    return binding
  }
  // One startup repair pass, not a periodic history scan. Normal terminal events are
  // created in the ledger transaction by schema-v41 triggers.
  db.prepare(`INSERT OR IGNORE INTO report_outbox(workspace_id,target_agent_id,dispatch_id,payload,created_at)
    SELECT d.workspace_id,d.from_agent_id,d.id,COALESCE(d.report_text,''),COALESCE(d.reported_at,d.created_at)
    FROM dispatches d JOIN workspaces w ON w.id=d.workspace_id
    WHERE w.controller_mode='codex_app' AND d.from_agent_id=d.workspace_id||':orchestrator'
      AND d.workflow_run_id IS NULL AND d.status IN ('reported','cancelled')
      AND NOT EXISTS(SELECT 1 FROM report_outbox o WHERE o.dispatch_id=d.id)`).run()
  const pendingCount = (workspaceId: string) =>
    (
      db
        .prepare(`
    SELECT COUNT(*) AS n FROM report_outbox o WHERE workspace_id = ?
      AND target_agent_id = ? AND ${controllerReceiptPendingSql}
  `)
        .get(workspaceId, `${workspaceId}:orchestrator`) as { n: number }
    ).n
  const hasBusyOperation = (workspaceId: string) =>
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM controller_operations WHERE workspace_id = ? AND state = 'pending' LIMIT 1"
        )
        .get(workspaceId)
    )
  const readReports = (workspaceId: string): ControllerReport[] =>
    db.transaction(() => {
      const rows = db
        .prepare(`
      SELECT o.id, o.dispatch_id AS receipt_dispatch_id, COALESCE(o.source_dispatch_id,o.dispatch_id) AS dispatch_id, o.event_kind AS kind, COALESCE(w.name, d.to_agent_id, 'removed member') AS worker_name,
        CASE WHEN o.event_kind IN ('member_exit','dispatch_message') THEN 'needs_attention' ELSE COALESCE(d.status, 'cancelled') END AS status,
        CASE WHEN o.event_kind IN ('member_exit','dispatch_message') THEN NULL ELSE d.outcome END AS outcome,
        CASE WHEN o.event_kind IN ('member_exit','dispatch_message') THEN o.payload ELSE COALESCE(d.report_text, o.payload) END AS result,
        CASE WHEN o.event_kind IN ('member_exit','dispatch_message') THEN '[]' ELSE d.artifacts END AS artifacts
      FROM report_outbox o LEFT JOIN dispatches d ON d.id = COALESCE(o.source_dispatch_id,o.dispatch_id)
      LEFT JOIN workers w ON w.id = d.to_agent_id
      WHERE o.workspace_id = ? AND o.target_agent_id = ? AND ${controllerReceiptPendingSql}
      ORDER BY o.id LIMIT 100
    `)
        .all(workspaceId, `${workspaceId}:orchestrator`) as Array<
        Omit<ControllerReport, 'artifacts'> & {
          artifacts: string | null
          receipt_dispatch_id: string
        }
      >
      const markRead = db.prepare('UPDATE report_outbox SET read_at = ? WHERE id = ?')
      for (const row of rows) markRead.run(Date.now(), row.id)
      return rows.map(({ receipt_dispatch_id, ...row }) => {
        const messageId =
          row.kind === 'dispatch_message' ? receipt_dispatch_id.slice('message:'.length) : null
        if (messageId)
          db.prepare(`UPDATE dispatch_message_outbox SET state = 'delivered', delivered_at = COALESCE(delivered_at, ?), error = NULL
          WHERE message_id = ? AND state IN ('queued','delivering')`).run(Date.now(), messageId)
        const message = messageId ? readDispatchMessage(db, workspaceId, messageId) : undefined
        return {
          ...row,
          artifacts: row.artifacts ? (JSON.parse(row.artifacts) as string[]) : [],
          ...(message ? { message: serializeDispatchMessage(message) } : {}),
        }
      })
    })()
  const ackReports = (workspaceId: string, ids: number[]) =>
    db.transaction(() => {
      const read = db.prepare(
        'SELECT read_at FROM report_outbox WHERE id = ? AND workspace_id = ? AND target_agent_id = ?'
      )
      for (const id of ids) {
        const row = read.get(id, workspaceId, `${workspaceId}:orchestrator`) as
          | { read_at: number | null }
          | undefined
        if (!row || row.read_at === null)
          throw new ConflictError('Read every report before acknowledging it')
      }
      const ack = db.prepare(
        'UPDATE report_outbox SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?'
      )
      for (const id of ids) ack.run(Date.now(), id)
    })()
  return {
    get,
    requireThread,
    pendingCount,
    hasBusyOperation,
    hasSendingNotification: (workspaceId: string) =>
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM report_outbox WHERE workspace_id = ? AND notification_state = 'sending' LIMIT 1"
          )
          .get(workspaceId)
      ),
    readReports,
    ackReports,
    request(workspaceId: string, threadId: string) {
      const row = get(workspaceId)
      if (row.thread_id && row.thread_id !== threadId)
        throw new ConflictError(
          'Disconnect the current controller in Hive before requesting another task'
        )
      if (row.request_thread_id && row.request_thread_id !== threadId)
        throw new ConflictError('Another connection request is pending in Hive')
      if (row.thread_id === threadId || row.request_thread_id === threadId) return row
      db.prepare(
        'UPDATE workspace_controllers SET request_id = ?, request_thread_id = ? WHERE workspace_id = ?'
      ).run(randomUUID(), threadId, workspaceId)
      return get(workspaceId)
    },
    confirm(workspaceId: string, requestId: string) {
      const row = get(workspaceId)
      if (!row.request_id || row.request_id !== requestId || !row.request_thread_id)
        throw new ConflictError('The connection request is no longer current')
      if (row.thread_id) throw new ConflictError('A controller is already connected')
      db.prepare(
        'UPDATE workspace_controllers SET thread_id = request_thread_id, request_id = NULL, request_thread_id = NULL, connection_error = ? WHERE workspace_id = ?'
      ).run(
        'Controller is bound; the initial notification is pending or its outcome is unknown. Use inspect in the bound task before starting work.',
        workspaceId
      )
      return row.request_thread_id
    },
    disconnect(workspaceId: string) {
      db.prepare(`UPDATE dispatch_message_outbox SET state = 'cancelled'
        WHERE state = 'queued' AND message_id IN (
          SELECT m.id FROM dispatch_messages m JOIN dispatches d ON d.id = m.dispatch_id
          JOIN workspace_controllers c ON c.workspace_id = m.workspace_id
          WHERE m.workspace_id = ? AND m.kind = 'question' AND d.status = 'reported'
            AND m.controller_thread_id = c.thread_id
        )`).run(workspaceId)
      db.prepare(
        'UPDATE workspace_controllers SET thread_id = NULL, request_id = NULL, request_thread_id = NULL, connection_error = NULL WHERE workspace_id = ?'
      ).run(workspaceId)
    },
    setConnectionError(workspaceId: string, requestId: string, error: string) {
      db.prepare(
        'UPDATE workspace_controllers SET connection_error = ? WHERE workspace_id = ? AND request_id = ? AND thread_id IS NULL'
      ).run(error, workspaceId, requestId)
    },
    recentProgress(workspaceId: string) {
      return db
        .prepare(`SELECT m.sequence AS id, m.worker_id, COALESCE(w.name,m.worker_id) AS worker_name, m.text, m.created_at
        FROM messages m LEFT JOIN workers w ON w.id=m.worker_id
        WHERE m.workspace_id=? AND m.type='status' ORDER BY m.sequence DESC LIMIT 20`)
        .all(workspaceId)
    },
    notificationError(workspaceId: string) {
      const row = db
        .prepare(`SELECT notification_error FROM report_outbox o WHERE workspace_id = ?
        AND ${controllerReceiptPendingSql} AND notification_error IS NOT NULL ORDER BY id DESC LIMIT 1`)
        .get(workspaceId) as { notification_error: string } | undefined
      return row?.notification_error ?? null
    },
    reserveOperation(
      workspaceId: string,
      threadId: string,
      operationId: string,
      inputJson: string
    ) {
      const existing = db
        .prepare(
          'SELECT thread_id, input_json, state, result_json FROM controller_operations WHERE workspace_id = ? AND operation_id = ?'
        )
        .get(workspaceId, operationId) as
        | { thread_id: string; input_json: string; state: string; result_json: string | null }
        | undefined
      if (existing) {
        if (existing.thread_id !== threadId || existing.input_json !== inputJson)
          throw new ConflictError('operation_id was already used for a different action')
        if (existing.state !== 'completed')
          throw new ConflictError(
            'This operation has no confirmed success receipt; inspect the team before issuing a new operation_id'
          )
        return {
          replay: true as const,
          result: JSON.parse(existing.result_json ?? 'null') as unknown,
        }
      }
      db.prepare(
        "INSERT INTO controller_operations(workspace_id,operation_id,thread_id,input_json,state) VALUES (?,?,?,?,'pending')"
      ).run(workspaceId, operationId, threadId, inputJson)
      return { replay: false as const }
    },
    finishOperation(
      workspaceId: string,
      operationId: string,
      state: 'completed' | 'failed',
      result: unknown
    ) {
      db.prepare(
        'UPDATE controller_operations SET state = ?, result_json = ? WHERE workspace_id = ? AND operation_id = ?'
      ).run(state, JSON.stringify(result), workspaceId, operationId)
    },
  }
}
export type ControllerStore = ReturnType<typeof createControllerStore>
