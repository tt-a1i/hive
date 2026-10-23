import { randomUUID } from 'node:crypto'
import type { DispatchMessageKind, DispatchMessageRecord } from '../shared/team-collaboration.js'
import {
  dispatchMessageEligibilitySql,
  isDispatchMessageEligible,
} from './dispatch-message-delivery-policy.js'
import { BadRequestError, ConflictError } from './http-errors.js'
import type { Database } from './sqlite.js'

type MessageRow = {
  id: string
  workspace_id: string
  dispatch_id: string
  source_dispatch_id: string | null
  sequence: number
  from_agent_id: string
  recipient_agent_id: string
  kind: DispatchMessageKind
  reply_to: string | null
  text: string
  created_at: number
  delivery_state: DispatchMessageRecord['deliveryState']
  delivered_at: number | null
  error: string | null
}
const select = `SELECT m.*, COALESCE(o.state, 'recorded') AS delivery_state, o.delivered_at, o.error
  FROM dispatch_messages m LEFT JOIN dispatch_message_outbox o ON o.message_id = m.id`
const toRecord = (row: MessageRow): DispatchMessageRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  dispatchId: row.dispatch_id,
  sourceDispatchId: row.source_dispatch_id,
  sequence: row.sequence,
  fromAgentId: row.from_agent_id,
  recipientAgentId: row.recipient_agent_id,
  kind: row.kind,
  replyTo: row.reply_to,
  text: row.text,
  createdAt: row.created_at,
  deliveryState: row.delivery_state,
  deliveredAt: row.delivered_at,
  deliveryError: row.error,
})

export interface CollaborationHistoryCursor {
  afterMessageId?: string
  beforeMessageId?: string
  aroundMessageId?: string
}

export const readDispatchMessage = (db: Database, workspaceId: string, id: string) => {
  const row = db.prepare(`${select} WHERE m.workspace_id = ? AND m.id = ?`).get(workspaceId, id) as
    | MessageRow
    | undefined
  return row ? toRecord(row) : undefined
}

export const createDispatchMessageStore = (db: Database) => {
  // A previous process could exit after writing the PTY but before recording it.
  // Stable message IDs make this explicit at-least-once redelivery recognizable.
  db.prepare("UPDATE dispatch_message_outbox SET state = 'queued' WHERE state = 'delivering'").run()
  const controllerBinding = (workspaceId: string) => {
    const row = db
      .prepare(`SELECT w.controller_mode, c.thread_id FROM workspaces w
      LEFT JOIN workspace_controllers c ON c.workspace_id = w.id WHERE w.id = ?`)
      .get(workspaceId) as { controller_mode: string; thread_id: string | null } | undefined
    return { external: row?.controller_mode === 'codex_app', threadId: row?.thread_id ?? null }
  }
  const messageControllerThread = (workspaceId: string, messageId: string) =>
    (
      db
        .prepare(
          'SELECT controller_thread_id FROM dispatch_messages WHERE workspace_id = ? AND id = ?'
        )
        .get(workspaceId, messageId) as { controller_thread_id: string | null } | undefined
    )?.controller_thread_id ?? null
  const getMessage = (workspaceId: string, id: string) => readDispatchMessage(db, workspaceId, id)
  const listWorkspaceMessages = (workspaceId: string) =>
    (
      db
        .prepare(`${select} WHERE m.workspace_id = ? ORDER BY m.created_at, m.rowid`)
        .all(workspaceId) as MessageRow[]
    ).map(toRecord)
  const listRecentMessages = (workspaceId: string, limit = 12) =>
    (
      db
        .prepare(`${select} WHERE m.workspace_id = ? ORDER BY m.rowid DESC LIMIT ?`)
        .all(workspaceId, Math.min(100, Math.max(1, limit))) as MessageRow[]
    )
      .map(toRecord)
      .reverse()
  const listMessageHistory = (workspaceId: string, dispatchId: string, afterSeq = 0, limit = 100) =>
    (
      db
        .prepare(
          `${select} WHERE m.workspace_id = ? AND m.dispatch_id = ? AND m.sequence > ? ORDER BY m.sequence LIMIT ?`
        )
        .all(workspaceId, dispatchId, afterSeq, Math.min(101, Math.max(1, limit))) as MessageRow[]
    ).map(toRecord)
  const listActionableWorkspaceMessages = (workspaceId: string, recipientAgentId?: string) =>
    (
      db
        .prepare(`${select} WHERE m.workspace_id = ? ${recipientAgentId ? 'AND m.recipient_agent_id = ?' : ''} AND COALESCE(o.state, 'recorded') != 'cancelled'
      AND ${dispatchMessageEligibilitySql}
      AND ((m.kind = 'question' AND NOT EXISTS (SELECT 1 FROM dispatch_messages answer WHERE answer.reply_to = m.id AND answer.kind = 'answer'))
        OR o.state IN ('queued','delivering'))
      ORDER BY m.rowid LIMIT 100`)
        .all(
          ...(recipientAgentId ? [workspaceId, recipientAgentId] : [workspaceId])
        ) as MessageRow[]
    ).map(toRecord)
  const listRecoveryMessages = (workspaceId: string) =>
    (
      db
        .prepare(`${select} WHERE m.workspace_id = ? AND m.dispatch_id IN (
      SELECT id FROM dispatches WHERE workspace_id = ? AND status IN ('queued','submitted')
    ) ORDER BY m.rowid DESC LIMIT 100`)
        .all(workspaceId, workspaceId) as MessageRow[]
    )
      .map(toRecord)
      .reverse()
  const listRootMessageHistory = (
    workspaceId: string,
    rootDispatchId: string,
    cursor: CollaborationHistoryCursor = {}
  ) =>
    db.transaction(() => {
      const anchors = [
        cursor.afterMessageId,
        cursor.beforeMessageId,
        cursor.aroundMessageId,
      ].filter((id) => id !== undefined)
      if (anchors.length > 1) throw new BadRequestError('Message cursors are mutually exclusive')
      const scope = `m.workspace_id = ? AND m.dispatch_id IN (
        SELECT id FROM dispatches WHERE workspace_id = ? AND root_dispatch_id = ?)`
      const scopeParams = [workspaceId, workspaceId, rootDispatchId]
      const anchor = cursor.afterMessageId === '' ? undefined : anchors[0]
      const rowId = (id: string) => {
        const row = db
          .prepare(`SELECT m.rowid AS cursor FROM dispatch_messages m WHERE ${scope} AND m.id = ?`)
          .get(...scopeParams, id) as { cursor: number } | undefined
        if (!row) throw new ConflictError('Message cursor does not belong to this collaboration')
        return row.cursor
      }
      const anchorRow = anchor !== undefined ? rowId(anchor) : 0
      const read = (comparison: '>' | '>=' | '<', row: number, limit: number) => {
        const descending = comparison === '<'
        const rows = db
          .prepare(`${select} WHERE ${scope} AND m.rowid ${comparison} ?
            ORDER BY m.rowid ${descending ? 'DESC' : 'ASC'} LIMIT ?`)
          .all(...scopeParams, row, limit) as MessageRow[]
        return descending ? rows.reverse() : rows
      }
      const rows =
        cursor.aroundMessageId !== undefined
          ? [...read('<', anchorRow, 49), ...read('>=', anchorRow, 51)]
          : cursor.beforeMessageId !== undefined
            ? read('<', anchorRow, 100)
            : read('>', anchorRow, 100)
      const hasBeyond = (id: string, comparison: '<' | '>') =>
        db
          .prepare(
            `SELECT 1 FROM dispatch_messages m WHERE ${scope} AND m.rowid ${comparison} ? LIMIT 1`
          )
          .get(...scopeParams, rowId(id)) !== undefined
      const firstId = rows[0]?.id
      const lastId = rows.at(-1)?.id
      return {
        messages: rows.map(toRecord),
        previousBeforeMessageId: firstId && hasBeyond(firstId, '<') ? firstId : null,
        nextAfterMessageId: lastId && hasBeyond(lastId, '>') ? lastId : null,
      }
    })()
  const listMessages = (workspaceId: string, dispatchId: string, afterSeq = 0) =>
    (
      db
        .prepare(
          `${select} WHERE m.workspace_id = ? AND m.dispatch_id = ? AND m.sequence > ? ORDER BY m.sequence`
        )
        .all(workspaceId, dispatchId, afterSeq) as MessageRow[]
    ).map(toRecord)
  const requiredSeenSeq = (dispatchId: string, ownerId: string): number =>
    (
      db
        .prepare(`SELECT COALESCE(MAX(sequence), 0) AS seq FROM dispatch_messages
      WHERE dispatch_id = ? AND recipient_agent_id = ? AND from_agent_id != ? AND kind != 'progress'`)
        .get(dispatchId, ownerId, ownerId) as { seq: number }
    ).seq
  const insert = (
    input: Omit<
      DispatchMessageRecord,
      'id' | 'sequence' | 'createdAt' | 'deliveryState' | 'deliveredAt' | 'deliveryError'
    >
  ) => {
    const id = randomUUID()
    const sequence = (
      db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM dispatch_messages WHERE dispatch_id = ?'
        )
        .get(input.dispatchId) as { seq: number }
    ).seq
    const createdAt = Date.now()
    db.prepare(`INSERT INTO dispatch_messages
      (id, workspace_id, dispatch_id, source_dispatch_id, sequence, from_agent_id, recipient_agent_id, kind, reply_to, text, created_at, controller_thread_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      input.workspaceId,
      input.dispatchId,
      input.sourceDispatchId,
      sequence,
      input.fromAgentId,
      input.recipientAgentId,
      input.kind,
      input.replyTo,
      input.text,
      createdAt,
      input.kind === 'question' && input.fromAgentId === `${input.workspaceId}:orchestrator`
        ? controllerBinding(input.workspaceId).threadId
        : null
    )
    if (input.kind !== 'progress')
      db.prepare(
        "INSERT INTO dispatch_message_outbox (message_id, state) VALUES (?, 'queued')"
      ).run(id)
    if (
      input.kind !== 'progress' &&
      input.recipientAgentId === `${input.workspaceId}:orchestrator`
    ) {
      db.prepare(`INSERT OR IGNORE INTO report_outbox
        (workspace_id,target_agent_id,dispatch_id,payload,created_at,event_kind,source_dispatch_id)
        SELECT ?, ?, ?, ?, ?, 'dispatch_message', ? WHERE EXISTS (
          SELECT 1 FROM workspaces WHERE id = ? AND controller_mode = 'codex_app'
        )`).run(
        input.workspaceId,
        input.recipientAgentId,
        `message:${id}`,
        input.text,
        createdAt,
        input.dispatchId,
        input.workspaceId
      )
    }
    return getMessage(input.workspaceId, id) as DispatchMessageRecord
  }
  const listQueued = (workspaceId: string, targetAgentId?: string) =>
    (
      db
        .prepare(`${select} WHERE m.workspace_id = ? AND o.state = 'queued'
      ${targetAgentId ? 'AND m.recipient_agent_id = ?' : ''} ORDER BY m.created_at, m.rowid ${targetAgentId ? 'LIMIT 1' : ''}`)
        .all(...(targetAgentId ? [workspaceId, targetAgentId] : [workspaceId])) as MessageRow[]
    ).map(toRecord)
  const claim = (messageId: string) =>
    db
      .prepare(
        "UPDATE dispatch_message_outbox SET state = 'delivering' WHERE message_id = ? AND state = 'queued'"
      )
      .run(messageId).changes === 1
  const delivered = (messageId: string) =>
    db
      .prepare(
        "UPDATE dispatch_message_outbox SET state = 'delivered', delivered_at = ?, error = NULL WHERE message_id = ? AND state = 'delivering'"
      )
      .run(Date.now(), messageId)
  const failed = (messageId: string, error: string) =>
    db
      .prepare(
        "UPDATE dispatch_message_outbox SET state = 'queued', error = ? WHERE message_id = ? AND state = 'delivering'"
      )
      .run(error, messageId)
  const cancel = (messageId: string) =>
    db
      .prepare(
        "UPDATE dispatch_message_outbox SET state = 'cancelled' WHERE message_id = ? AND state IN ('queued','delivering')"
      )
      .run(messageId)
  return {
    controllerBinding,
    messageControllerThread,
    isEligible: (messageId: string) => isDispatchMessageEligible(db, messageId),
    getMessage,
    listActionableWorkspaceMessages,
    listRecentMessages,
    listRootMessageHistory,
    listMessageHistory,
    listRecoveryMessages,
    listWorkspaceMessages,
    listMessages,
    requiredSeenSeq,
    insert,
    listQueued,
    claim,
    delivered,
    failed,
    cancel,
  }
}
export type DispatchMessageStore = ReturnType<typeof createDispatchMessageStore>
