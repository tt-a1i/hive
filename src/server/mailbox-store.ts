import { randomUUID } from 'node:crypto'
import { readDispatchMessage } from './dispatch-message-store.js'
import { ConflictError, ForbiddenError } from './http-errors.js'
import type { Database } from './sqlite.js'

interface BatchRow {
  id: string
  workspace_id: string
  agent_id: string
  message_ids: string
  acknowledged_at: number | null
}

/** Caller may compose this transaction with report; a failed report rolls it back. */
export const acknowledgeMailboxBatch = (
  db: Database,
  workspaceId: string,
  agentId: string,
  batchId: string
) =>
  db.transaction(() => {
    const batch = db.prepare('SELECT * FROM mailbox_batches WHERE id = ?').get(batchId) as
      | BatchRow
      | undefined
    if (!batch) throw new ConflictError('Mailbox batch does not exist')
    if (batch.workspace_id !== workspaceId || batch.agent_id !== agentId)
      throw new ForbiddenError('Mailbox batch belongs to another member')
    const ids = JSON.parse(batch.message_ids) as string[]
    if (batch.acknowledged_at === null) {
      const now = Date.now()
      const insert = db.prepare(
        'INSERT OR IGNORE INTO mailbox_receipts(message_id,batch_id,acknowledged_at) VALUES (?,?,?)'
      )
      for (const id of ids) insert.run(id, batchId, now)
      db.prepare('UPDATE mailbox_batches SET acknowledged_at = ? WHERE id = ?').run(now, batchId)
    }
    return { batchId, acknowledgedMessageIds: ids }
  })()

export const createMailboxStore = (db: Database) => ({
  readMailbox: (workspaceId: string, agentId: string) =>
    db.transaction(() => {
      let batch = db
        .prepare(
          'SELECT * FROM mailbox_batches WHERE workspace_id = ? AND agent_id = ? AND acknowledged_at IS NULL'
        )
        .get(workspaceId, agentId) as BatchRow | undefined
      if (!batch) {
        // Only still-actionable inputs enter a new batch. Previously issued batches
        // remain replayable even if their responsibility closes in the meantime.
        const rows = db
          .prepare(`SELECT m.id, m.text FROM dispatch_messages m
        JOIN dispatches d ON d.id = m.dispatch_id
        WHERE m.workspace_id = ? AND m.recipient_agent_id = ? AND m.from_agent_id != ?
          AND m.kind != 'progress'
          AND NOT EXISTS (SELECT 1 FROM mailbox_receipts r WHERE r.message_id = m.id)
          AND (d.status IN ('queued','submitted') OR
            (d.status = 'reported' AND m.kind = 'question'
              AND NOT EXISTS (SELECT 1 FROM dispatch_messages a WHERE a.reply_to = m.id AND a.kind = 'answer')))
          AND (m.kind != 'question' OR NOT EXISTS (
            SELECT 1 FROM dispatch_message_outbox o WHERE o.message_id = m.id AND o.state = 'cancelled'))
        ORDER BY m.rowid LIMIT 50`)
          .all(workspaceId, agentId, agentId) as { id: string; text: string }[]
        const ids: string[] = []
        let bytes = 0
        for (const row of rows) {
          const size = Buffer.byteLength(row.text, 'utf8')
          if (ids.length && bytes + size > 65536) break
          ids.push(row.id)
          bytes += size
        }
        if (!ids.length) return { batchId: null, messages: [] }
        batch = {
          id: randomUUID(),
          workspace_id: workspaceId,
          agent_id: agentId,
          message_ids: JSON.stringify(ids),
          acknowledged_at: null,
        }
        db.prepare(
          'INSERT INTO mailbox_batches(id,workspace_id,agent_id,message_ids,created_at) VALUES (?,?,?,?,?)'
        ).run(batch.id, workspaceId, agentId, batch.message_ids, Date.now())
      }
      const ids = JSON.parse(batch.message_ids) as string[]
      const messages = ids
        .map((id) => readDispatchMessage(db, workspaceId, id))
        .filter((message) => message !== undefined)
      return { batchId: batch.id, messages }
    })(),
  acknowledgeMailbox: (workspaceId: string, agentId: string, batchId: string) =>
    acknowledgeMailboxBatch(db, workspaceId, agentId, batchId),
})
