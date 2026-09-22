import { randomUUID } from 'node:crypto'
import {
  delegatedDescendantIds,
  recordDelegatedResult,
  validateDelegation,
} from './dispatch-delegation.js'
import { retireClosedDispatchMessages } from './dispatch-message-delivery-policy.js'
import { ConflictError } from './http-errors.js'
import { acknowledgeMailboxBatch } from './mailbox-store.js'
import type { Database } from './sqlite.js'

export type DispatchStatus = 'queued' | 'submitted' | 'reported' | 'cancelled'

export interface DispatchRecord {
  cancelledDescendants?: DispatchRecord[]
  outcome?: 'success' | 'failed' | null
  delegatedFromId?: string | null
  parentDispatchId?: string | null
  rootDispatchId?: string
  seenSeq?: number
  artifacts: string[]
  createdAt: number
  deliveredAt: number | null
  dispatchPayloadBytes: number | null
  fromAgentId: string | null
  id: string
  label: string | null
  phase: string | null
  reportedAt: number | null
  reportPayloadBytes: number | null
  reportText: string | null
  sequence: number | null
  status: DispatchStatus
  stepIndex: number | null
  submittedAt: number | null
  text: string
  toAgentId: string
  workflowRunId: string | null
  workspaceId: string
}

interface DispatchRow {
  outcome: 'success' | 'failed' | null
  delegated_from_id: string | null
  parent_dispatch_id: string | null
  root_dispatch_id: string
  seen_seq: number
  artifacts: string | null
  created_at: number
  delivered_at: number | null
  dispatch_payload_bytes: number | null
  from_agent_id: string | null
  id: string
  label: string | null
  phase: string | null
  reported_at: number | null
  report_payload_bytes: number | null
  report_text: string | null
  sequence: number
  status: DispatchStatus
  step_index: number | null
  submitted_at: number | null
  text: string
  to_agent_id: string
  workflow_run_id: string | null
  workspace_id: string
}

export interface CreateDispatchInput {
  delegatedFromId?: string
  relatedToDispatchId?: string
  fromAgentId?: string
  label?: string
  phase?: string
  stepIndex?: number
  text: string
  toAgentId: string
  workflowRunId?: string
  workspaceId: string
}

interface ReportDispatchInput {
  ackBatchId?: string
  outcome?: 'success' | 'failed'
  seenSeq?: number
  artifacts: string[]
  dispatchId?: string
  reportText: string
  toAgentId: string
  workspaceId: string
}

interface CancelDispatchInput {
  dispatchId: string
  reason: string
  workspaceId: string
}

export interface ListDispatchesOptions {
  reportedSince?: number
  limit?: number
  offset?: number
  status?: DispatchStatus
}

const parseArtifacts = (value: string | null) => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((artifact): artifact is string => typeof artifact === 'string')
      : []
  } catch {
    return []
  }
}

const toRecord = (row: DispatchRow): DispatchRecord => ({
  outcome: row.outcome ?? null,
  delegatedFromId: row.delegated_from_id ?? null,
  parentDispatchId: row.parent_dispatch_id,
  rootDispatchId: row.root_dispatch_id,
  seenSeq: row.seen_seq,
  artifacts: parseArtifacts(row.artifacts),
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  dispatchPayloadBytes: row.dispatch_payload_bytes ?? null,
  fromAgentId: row.from_agent_id,
  id: row.id,
  label: row.label ?? null,
  phase: row.phase ?? null,
  reportedAt: row.reported_at,
  reportPayloadBytes: row.report_payload_bytes ?? null,
  reportText: row.report_text,
  sequence: row.sequence,
  status: row.status,
  stepIndex: row.step_index,
  submittedAt: row.submitted_at,
  text: row.text,
  toAgentId: row.to_agent_id,
  workflowRunId: row.workflow_run_id,
  workspaceId: row.workspace_id,
})

export const createDispatchLedgerStore = (db: Database) => {
  const getDispatch = (workspaceId: string, dispatchId: string) => {
    const row = db
      .prepare('SELECT * FROM dispatches WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, dispatchId) as DispatchRow | undefined
    return row ? toRecord(row) : undefined
  }
  const listRelatedDispatches = (workspaceId: string, rootDispatchId: string) =>
    (
      db
        .prepare(
          'SELECT * FROM dispatches WHERE workspace_id = ? AND root_dispatch_id = ? ORDER BY sequence'
        )
        .all(workspaceId, rootDispatchId) as DispatchRow[]
    ).map(toRecord)
  const createDispatch = db.transaction((input: CreateDispatchInput) => {
    if (input.delegatedFromId) {
      if (input.relatedToDispatchId) throw new ConflictError('A delegation has exactly one parent')
      validateDelegation(
        db,
        input.workspaceId,
        input.delegatedFromId,
        input.fromAgentId,
        input.toAgentId
      )
    }
    const parentId = input.delegatedFromId ?? input.relatedToDispatchId
    const parent = parentId ? getDispatch(input.workspaceId, parentId) : undefined
    if (input.relatedToDispatchId && !parent)
      throw new ConflictError('Related dispatch does not exist in this workspace')
    const id = randomUUID()
    const record: DispatchRecord = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      dispatchPayloadBytes: null,
      fromAgentId: input.fromAgentId ?? null,
      id,
      parentDispatchId: parent?.id ?? null,
      rootDispatchId: parent?.rootDispatchId ?? parent?.id ?? id,
      seenSeq: 0,
      outcome: null,
      delegatedFromId: input.delegatedFromId ?? null,
      label: input.label ?? null,
      phase: input.phase ?? null,
      reportedAt: null,
      reportPayloadBytes: null,
      reportText: null,
      sequence: null,
      status: 'queued',
      stepIndex: input.stepIndex ?? null,
      submittedAt: null,
      text: input.text,
      toAgentId: input.toAgentId,
      workflowRunId: input.workflowRunId ?? null,
      workspaceId: input.workspaceId,
    }

    db.prepare(
      `INSERT INTO dispatches (
        id,
        workspace_id,
        from_agent_id,
        to_agent_id,
        text,
        status,
        created_at,
        delivered_at,
        submitted_at,
        reported_at,
        report_text,
        artifacts,
        workflow_run_id,
        step_index,
        phase,
        label, parent_dispatch_id, root_dispatch_id, seen_seq, delegated_from_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.workspaceId,
      record.fromAgentId,
      record.toAgentId,
      record.text,
      record.status,
      record.createdAt,
      record.deliveredAt,
      record.submittedAt,
      record.reportedAt,
      record.reportText,
      JSON.stringify(record.artifacts),
      record.workflowRunId,
      record.stepIndex,
      record.phase,
      record.label,
      record.parentDispatchId ?? null,
      record.rootDispatchId ?? null,
      0,
      input.delegatedFromId ?? null
    )

    return record
  })

  const deleteDispatch = (dispatchId: string) => {
    db.prepare('DELETE FROM dispatches WHERE id = ?').run(dispatchId)
    retireClosedDispatchMessages(db, dispatchId)
  }

  /** Atomic claim for delivery: flips queued → submitted only if still
   *  queued. Exactly one of N racing deliverers (send path, start replay)
   *  wins; the rest skip the PTY write. */
  const claimQueuedDispatch = (dispatchId: string): boolean => {
    const result = db
      .prepare(
        `UPDATE dispatches
         SET status = 'submitted', submitted_at = ?
         WHERE id = ? AND status = 'queued'`
      )
      .run(Date.now(), dispatchId)
    return result.changes === 1
  }

  /** Inverse of claimQueuedDispatch for replay failures: the write never
   *  reached a live PTY (PtyInactive), so the dispatch goes back to parked
   *  instead of being cancelled — the next worker start retries it. Only a
   *  still-'submitted' row can be reparked (a report/cancel wins). */
  const reparkClaimedDispatch = (dispatchId: string): boolean => {
    const result = db
      .prepare(
        `UPDATE dispatches
         SET status = 'queued', submitted_at = NULL, delivered_at = NULL, dispatch_payload_bytes = NULL
         WHERE id = ? AND status = 'submitted'`
      )
      .run(dispatchId)
    return result.changes === 1
  }

  const markDelivered = (input: {
    deliveredAt: number
    dispatchId: string
    dispatchPayloadBytes: number
  }) => {
    // Only claimed (submitted) rows accept a delivery stamp. A report that
    // closes the row before the PTY write resolves leaves delivered_at
    // NULL ("reported before delivery confirmed"); metrics skip those
    // rows rather than inventing a duration.
    db.prepare(
      `UPDATE dispatches
       SET delivered_at = COALESCE(delivered_at, ?),
           dispatch_payload_bytes = COALESCE(dispatch_payload_bytes, ?)
       WHERE id = ? AND status = 'submitted'`
    ).run(input.deliveredAt, input.dispatchPayloadBytes, input.dispatchId)
  }

  const recordReportPayloadBytes = (dispatchId: string, bytes: number) => {
    db.prepare(
      `UPDATE dispatches
       SET report_payload_bytes = COALESCE(report_payload_bytes, ?)
       WHERE id = ?`
    ).run(bytes, dispatchId)
  }

  const listSubmittedForWorker = (workspaceId: string, toAgentId: string) =>
    (
      db
        .prepare(
          `SELECT *
           FROM dispatches
           WHERE workspace_id = ?
             AND to_agent_id = ?
             AND status = 'submitted'
           ORDER BY sequence ASC`
        )
        .all(workspaceId, toAgentId) as DispatchRow[]
    ).map(toRecord)

  /** Reportable target for a worker token (spec issue #79): only work that
   *  was actually claimed for delivery (`submitted`) may be reported.
   *  Without an id, exactly one submitted row is reportable — zero or more
   *  than one is a conflict. Queued rows were never pasted into the worker's
   *  PTY and are never reportable. Cancel keeps its own wider lookup
   *  (findOpenDispatchById: queued + submitted). */
  const findOpenDispatch = (workspaceId: string, toAgentId: string, dispatchId?: string) => {
    if (dispatchId) {
      const row = db
        .prepare(
          `SELECT *
           FROM dispatches
           WHERE id = ?
             AND workspace_id = ?
             AND to_agent_id = ?
             AND status IN ('queued', 'submitted')
           LIMIT 1`
        )
        .get(dispatchId, workspaceId, toAgentId) as DispatchRow | undefined

      if (!row) return undefined
      const record = toRecord(row)
      // A still-queued row was never pasted into the worker's PTY; a worker
      // token must not be able to close parked work as done.
      if (record.status !== 'submitted') return undefined
      return record
    }

    const submitted = listSubmittedForWorker(workspaceId, toAgentId)
    return submitted.length === 1 ? submitted[0] : undefined
  }

  const findOpenDispatchById = (workspaceId: string, dispatchId: string) => {
    const row = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE id = ?
           AND workspace_id = ?
           AND status IN ('queued', 'submitted')
         LIMIT 1`
      )
      .get(dispatchId, workspaceId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const markReportedByWorker = (input: ReportDispatchInput) =>
    db.transaction(() => {
      const dispatch = findOpenDispatch(input.workspaceId, input.toAgentId, input.dispatchId)
      if (!dispatch) {
        return undefined
      }

      if (
        db
          .prepare(
            "SELECT 1 FROM dispatches WHERE delegated_from_id = ? AND status IN ('queued','submitted') LIMIT 1"
          )
          .get(dispatch.id)
      )
        throw new ConflictError(
          'Finish or cancel your delegated children before reporting this responsibility'
        )
      if (input.ackBatchId)
        acknowledgeMailboxBatch(db, input.workspaceId, input.toAgentId, input.ackBatchId)

      const required = (
        db
          .prepare(`SELECT COALESCE(MAX(sequence), 0) AS seq FROM dispatch_messages
      WHERE dispatch_id = ? AND recipient_agent_id = ? AND from_agent_id != ? AND kind != 'progress'`)
          .get(dispatch.id, dispatch.toAgentId, dispatch.toAgentId) as { seq: number }
      ).seq
      const seenSeq = input.seenSeq ?? 0
      const unacknowledged = db
        .prepare(`SELECT 1 FROM dispatch_messages m
        WHERE m.dispatch_id = ? AND m.recipient_agent_id = ? AND m.from_agent_id != ?
          AND m.kind != 'progress' AND m.sequence > ?
          AND NOT EXISTS (SELECT 1 FROM mailbox_receipts r WHERE r.message_id = m.id) LIMIT 1`)
        .get(dispatch.id, dispatch.toAgentId, dispatch.toAgentId, seenSeq)
      if (
        !Number.isSafeInteger(seenSeq) ||
        seenSeq < 0 ||
        seenSeq > required ||
        (seenSeq !== required && unacknowledged)
      ) {
        throw new ConflictError(
          `Dispatch ${dispatch.id} has unacknowledged inputs. Read \`team inbox\`, consider the batch, then report this dispatch with \`--ack <batch-id>\`; or read \`team messages --dispatch ${dispatch.id}\` and use \`--seen ${required}\`. Do not substitute another dispatch ID.`
        )
      }
      const reportedAt = Date.now()
      db.prepare(
        `UPDATE dispatches
       SET status = ?,
           reported_at = ?,
           report_text = ?,
           artifacts = ?,
           seen_seq = ?, outcome = ?
       WHERE id = ?`
      ).run(
        'reported',
        reportedAt,
        input.reportText,
        JSON.stringify(input.artifacts),
        required,
        input.outcome ?? null,
        dispatch.id
      )
      retireClosedDispatchMessages(db, dispatch.id)

      recordDelegatedResult(db, input.workspaceId, dispatch.id)

      return {
        ...dispatch,
        artifacts: input.artifacts,
        reportedAt,
        reportText: input.reportText,
        seenSeq: required,
        outcome: input.outcome ?? null,
        status: 'reported' as const,
      }
    })()

  const markCancelled = (input: CancelDispatchInput) =>
    db.transaction(() => {
      const dispatch = findOpenDispatchById(input.workspaceId, input.dispatchId)
      if (!dispatch) {
        return undefined
      }

      const cancelledAt = Date.now()
      const descendants = delegatedDescendantIds(db, input.workspaceId, dispatch.id)
      db.prepare(
        `UPDATE dispatches
       SET status = ?,
           reported_at = ?,
           report_text = ?
       WHERE id = ?`
      ).run('cancelled', cancelledAt, input.reason, dispatch.id)
      retireClosedDispatchMessages(db, dispatch.id)
      for (const id of descendants) {
        db.prepare(
          "UPDATE dispatches SET status = 'cancelled', reported_at = ?, report_text = ? WHERE id = ?"
        ).run(cancelledAt, input.reason, id)
        retireClosedDispatchMessages(db, id)
      }
      recordDelegatedResult(db, input.workspaceId, dispatch.id)

      return {
        ...dispatch,
        reportedAt: cancelledAt,
        reportText: input.reason,
        status: 'cancelled' as const,
        cancelledDescendants: descendants
          .map((id) => getDispatch(input.workspaceId, id))
          .filter((item) => item !== undefined),
      }
    })()

  const listWorkspaceDispatches = (workspaceId: string, options: ListDispatchesOptions = {}) => {
    const offset = options.offset ?? 0
    const limit = options.limit ?? 100

    if (options.status === 'reported' && options.reportedSince !== undefined) {
      return (
        db
          .prepare(`SELECT * FROM dispatches
        WHERE workspace_id = ? AND status = 'reported' AND reported_at >= ?
        ORDER BY reported_at ASC, sequence ASC LIMIT ? OFFSET ?`)
          .all(workspaceId, options.reportedSince, limit, offset) as DispatchRow[]
      ).map(toRecord)
    }

    if (options.status) {
      return (
        db
          .prepare(
            `SELECT *
             FROM dispatches
             WHERE workspace_id = ?
               AND status = ?
             ORDER BY sequence ASC
             LIMIT ? OFFSET ?`
          )
          .all(workspaceId, options.status, limit, offset) as DispatchRow[]
      ).map(toRecord)
    }

    return (
      db
        .prepare(
          `SELECT *
           FROM dispatches
           WHERE workspace_id = ?
           ORDER BY sequence ASC
           LIMIT ? OFFSET ?`
        )
        .all(workspaceId, limit, offset) as DispatchRow[]
    ).map(toRecord)
  }

  const listRecentWorkspaceDispatches = (workspaceId: string, limit = 100) => {
    const rows = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
         ORDER BY sequence DESC, created_at DESC
         LIMIT ?`
      )
      .all(workspaceId, limit) as DispatchRow[]
    return rows.map(toRecord)
  }

  const listOpenWorkspaceDispatches = (workspaceId: string) => {
    const rows = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
           AND status IN ('queued', 'submitted')
         ORDER BY sequence ASC, created_at ASC`
      )
      .all(workspaceId) as DispatchRow[]
    return rows.map(toRecord)
  }

  const listOpenDispatchKinds = () => {
    return db
      .prepare(
        `SELECT workspace_id, to_agent_id AS worker_id, 'send' AS type
           FROM dispatches
           WHERE status IN ('queued', 'submitted')
           ORDER BY sequence ASC`
      )
      .all() as Array<{ type: 'send'; worker_id: string; workspace_id: string }>
  }

  const deleteWorkspaceDispatches = (workspaceId: string) => {
    db.prepare(
      'DELETE FROM mailbox_receipts WHERE batch_id IN (SELECT id FROM mailbox_batches WHERE workspace_id = ?)'
    ).run(workspaceId)
    db.prepare('DELETE FROM mailbox_batches WHERE workspace_id = ?').run(workspaceId)
    db.prepare(
      'DELETE FROM dispatch_message_outbox WHERE message_id IN (SELECT id FROM dispatch_messages WHERE workspace_id = ?)'
    ).run(workspaceId)
    db.prepare('DELETE FROM dispatch_messages WHERE workspace_id = ?').run(workspaceId)
    db.prepare('DELETE FROM dispatches WHERE workspace_id = ?').run(workspaceId)
  }

  const deleteWorkerDispatches = (workspaceId: string, workerId: string) =>
    db.transaction(() => {
      // Keep responsibility and conversation evidence after a member is removed.
      const affected = db
        .prepare(`SELECT id FROM dispatches WHERE workspace_id = ? AND status IN ('queued','submitted')
      AND (to_agent_id = ? OR (from_agent_id = ? AND delegated_from_id IS NOT NULL))`)
        .all(workspaceId, workerId, workerId) as { id: string }[]
      const cancelled = new Map<string, DispatchRecord>()
      for (const row of affected) {
        const result = markCancelled({ workspaceId, dispatchId: row.id, reason: 'Worker removed' })
        if (!result) continue
        for (const item of [result, ...(result.cancelledDescendants ?? [])])
          cancelled.set(item.id, item)
      }
      db.prepare(`UPDATE dispatch_message_outbox SET state = 'cancelled' WHERE state IN ('queued','delivering')
      AND message_id IN (SELECT id FROM dispatch_messages WHERE workspace_id = ?
        AND (recipient_agent_id = ? OR (from_agent_id = ? AND kind = 'question')))`).run(
        workspaceId,
        workerId,
        workerId
      )
      return [...cancelled.values()]
    })()

  // Every dispatch fired by a workflow run carries the run id (M1-B added the
  // column; M2-C plumbs it through). This is the timeline query the UI uses to
  // explode a run row into per-worker activity.
  const listWorkflowRunDispatches = (runId: string): DispatchRecord[] => {
    const rows = db
      .prepare('SELECT * FROM dispatches WHERE workflow_run_id = ? ORDER BY sequence, created_at')
      .all(runId) as DispatchRow[]
    return rows.map(toRecord)
  }

  // Open dispatch ids tied to a workflow run — drives the runner's stop path
  // (each id gets a notifyCancel so the runner's await rejects).
  const listOpenDispatchIdsForRun = (runId: string): string[] =>
    (
      db
        .prepare(
          `SELECT id FROM dispatches
           WHERE workflow_run_id = ? AND status IN ('queued', 'submitted')`
        )
        .all(runId) as Array<{ id: string }>
    ).map((row) => row.id)

  // Open workflow-tagged dispatches addressed to a specific worker. Drives the
  // PTY-exit cancel path (TIER 1 #1): when a workflow-spawned worker dies
  // without calling `team report`, the runner's `awaitReport` would otherwise
  // hang for DEFAULT_TIMEOUT_MS (10 min). The exit handler enumerates these
  // and `notifyCancel`s each so the surrounding `agent()`/`parallel`/`pipeline`
  // sees an immediate reject.
  const listOpenWorkflowDispatchesForWorker = (
    workspaceId: string,
    workerId: string
  ): Array<{ dispatchId: string; runId: string }> =>
    (
      db
        .prepare(
          `SELECT id, workflow_run_id FROM dispatches
           WHERE workspace_id = ?
             AND to_agent_id = ?
             AND workflow_run_id IS NOT NULL
             AND status IN ('queued', 'submitted')`
        )
        .all(workspaceId, workerId) as Array<{ id: string; workflow_run_id: string }>
    ).map((row) => ({ dispatchId: row.id, runId: row.workflow_run_id }))

  return {
    createDispatch,
    getDispatch,
    listRelatedDispatches,
    deleteDispatch,
    deleteWorkerDispatches,
    deleteWorkspaceDispatches,
    findOpenDispatch,
    findOpenDispatchById,
    claimQueuedDispatch,
    reparkClaimedDispatch,
    listOpenDispatchKinds,
    listOpenDispatchIdsForRun,
    listOpenWorkspaceDispatches,
    listOpenWorkflowDispatchesForWorker,
    listRecentWorkspaceDispatches,
    listWorkflowRunDispatches,
    listWorkspaceDispatches,
    markCancelled,
    markDelivered,
    markReportedByWorker,
    recordReportPayloadBytes,
  }
}
