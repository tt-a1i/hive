import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

type LegacyMessageRow = {
  artifacts: string | null
  created_at: number
  from_agent_id: string | null
  text: string | null
  to_agent_id: string | null
  type: string
  worker_id: string
  workspace_id: string
}

export const applySchemaVersion14 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatches (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      from_agent_id TEXT,
      to_agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      submitted_at INTEGER,
      reported_at INTEGER,
      report_text TEXT,
      artifacts TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dispatches_workspace_created_at
      ON dispatches (workspace_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_dispatches_open_by_worker
      ON dispatches (workspace_id, to_agent_id, status, sequence);
  `)

  backfillDispatchesFromMessages(db)
}

const backfillDispatchesFromMessages = (db: Database) => {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM dispatches').get() as {
    count: number
  }
  if (existing.count > 0) return

  const messages = db
    .prepare(
      `SELECT
         workspace_id,
         worker_id,
         type,
         from_agent_id,
         to_agent_id,
         text,
         artifacts,
         created_at
       FROM messages
       WHERE type IN ('send', 'report')
       ORDER BY sequence ASC`
    )
    .all() as LegacyMessageRow[]
  if (messages.length === 0) return

  const insertDispatch = db.prepare(
    `INSERT INTO dispatches (
       id,
       workspace_id,
       from_agent_id,
       to_agent_id,
       text,
       status,
       created_at,
       artifacts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const markReported = db.prepare(
    `UPDATE dispatches
     SET status = 'reported',
         reported_at = ?,
         report_text = ?,
         artifacts = ?
     WHERE id = ?`
  )
  const openByWorker = new Map<string, string[]>()

  const backfill = db.transaction(() => {
    for (const message of messages) {
      const queueKey = `${message.workspace_id}:${message.worker_id}`
      if (message.type === 'send') {
        const dispatchId = randomUUID()
        insertDispatch.run(
          dispatchId,
          message.workspace_id,
          message.from_agent_id,
          message.to_agent_id ?? message.worker_id,
          message.text ?? '',
          'queued',
          message.created_at,
          '[]'
        )
        const queue = openByWorker.get(queueKey) ?? []
        queue.push(dispatchId)
        openByWorker.set(queueKey, queue)
        continue
      }

      const queue = openByWorker.get(queueKey)
      const dispatchId = queue?.shift()
      if (!dispatchId) continue
      markReported.run(
        message.created_at,
        message.text ?? '',
        message.artifacts ?? '[]',
        dispatchId
      )
    }
  })

  backfill()
}
