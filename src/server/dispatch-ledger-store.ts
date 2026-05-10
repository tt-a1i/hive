import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

export type DispatchStatus = 'queued' | 'submitted' | 'reported'

export interface DispatchRecord {
  artifacts: string[]
  createdAt: number
  deliveredAt: number | null
  fromAgentId: string | null
  id: string
  reportedAt: number | null
  reportText: string | null
  sequence: number | null
  status: DispatchStatus
  submittedAt: number | null
  text: string
  toAgentId: string
  workspaceId: string
}

interface DispatchRow {
  artifacts: string | null
  created_at: number
  delivered_at: number | null
  from_agent_id: string | null
  id: string
  reported_at: number | null
  report_text: string | null
  sequence: number
  status: DispatchStatus
  submitted_at: number | null
  text: string
  to_agent_id: string
  workspace_id: string
}

interface CreateDispatchInput {
  fromAgentId?: string
  text: string
  toAgentId: string
  workspaceId: string
}

interface ReportDispatchInput {
  artifacts: string[]
  reportText: string
  toAgentId: string
  workspaceId: string
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
  artifacts: parseArtifacts(row.artifacts),
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  fromAgentId: row.from_agent_id,
  id: row.id,
  reportedAt: row.reported_at,
  reportText: row.report_text,
  sequence: row.sequence,
  status: row.status,
  submittedAt: row.submitted_at,
  text: row.text,
  toAgentId: row.to_agent_id,
  workspaceId: row.workspace_id,
})

export const createDispatchLedgerStore = (db: Database | undefined) => {
  const memoryDispatches = new Map<string, DispatchRecord>()

  const createDispatch = (input: CreateDispatchInput) => {
    const record: DispatchRecord = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: input.fromAgentId ?? null,
      id: randomUUID(),
      reportedAt: null,
      reportText: null,
      sequence: null,
      status: 'queued',
      submittedAt: null,
      text: input.text,
      toAgentId: input.toAgentId,
      workspaceId: input.workspaceId,
    }

    if (!db) {
      record.sequence = memoryDispatches.size + 1
      memoryDispatches.set(record.id, record)
      return record
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
        artifacts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      JSON.stringify(record.artifacts)
    )

    return record
  }

  const deleteDispatch = (dispatchId: string) => {
    if (!db) {
      memoryDispatches.delete(dispatchId)
      return
    }

    db.prepare('DELETE FROM dispatches WHERE id = ?').run(dispatchId)
  }

  const markSubmitted = (dispatchId: string) => {
    const submittedAt = Date.now()
    if (!db) {
      const record = memoryDispatches.get(dispatchId)
      if (record) {
        record.status = 'submitted'
        record.submittedAt = submittedAt
      }
      return
    }

    db.prepare(
      `UPDATE dispatches
       SET status = ?, submitted_at = ?
       WHERE id = ?`
    ).run('submitted', submittedAt, dispatchId)
  }

  const findOpenDispatch = (workspaceId: string, toAgentId: string) => {
    if (!db) {
      return Array.from(memoryDispatches.values())
        .filter(
          (record) =>
            record.workspaceId === workspaceId &&
            record.toAgentId === toAgentId &&
            record.status !== 'reported'
        )
        .sort((a, b) => (a.sequence ?? a.createdAt) - (b.sequence ?? b.createdAt))[0]
    }

    const row = db
      .prepare(
        `SELECT *
         FROM dispatches
         WHERE workspace_id = ?
           AND to_agent_id = ?
           AND status != 'reported'
         ORDER BY sequence ASC
         LIMIT 1`
      )
      .get(workspaceId, toAgentId) as DispatchRow | undefined

    return row ? toRecord(row) : undefined
  }

  const markReportedByWorker = (input: ReportDispatchInput) => {
    const dispatch = findOpenDispatch(input.workspaceId, input.toAgentId)
    if (!dispatch) {
      return undefined
    }

    const reportedAt = Date.now()
    if (!db) {
      dispatch.status = 'reported'
      dispatch.reportedAt = reportedAt
      dispatch.reportText = input.reportText
      dispatch.artifacts = input.artifacts
      return dispatch
    }

    db.prepare(
      `UPDATE dispatches
       SET status = ?,
           reported_at = ?,
           report_text = ?,
           artifacts = ?
       WHERE id = ?`
    ).run('reported', reportedAt, input.reportText, JSON.stringify(input.artifacts), dispatch.id)

    return {
      ...dispatch,
      artifacts: input.artifacts,
      reportedAt,
      reportText: input.reportText,
      status: 'reported' as const,
    }
  }

  const listWorkspaceDispatches = (workspaceId: string) => {
    if (!db) {
      return Array.from(memoryDispatches.values())
        .filter((record) => record.workspaceId === workspaceId)
        .sort((a, b) => (a.sequence ?? a.createdAt) - (b.sequence ?? b.createdAt))
    }

    return (
      db
        .prepare(
          `SELECT *
           FROM dispatches
           WHERE workspace_id = ?
           ORDER BY sequence ASC`
        )
        .all(workspaceId) as DispatchRow[]
    ).map(toRecord)
  }

  const deleteWorkspaceDispatches = (workspaceId: string) => {
    if (!db) {
      for (const [id, record] of memoryDispatches) {
        if (record.workspaceId === workspaceId) memoryDispatches.delete(id)
      }
      return
    }

    db.prepare('DELETE FROM dispatches WHERE workspace_id = ?').run(workspaceId)
  }

  const deleteWorkerDispatches = (workspaceId: string, workerId: string) => {
    if (!db) {
      for (const [id, record] of memoryDispatches) {
        if (record.workspaceId === workspaceId && record.toAgentId === workerId) {
          memoryDispatches.delete(id)
        }
      }
      return
    }

    db.prepare('DELETE FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?').run(
      workspaceId,
      workerId
    )
  }

  return {
    createDispatch,
    deleteDispatch,
    deleteWorkerDispatches,
    deleteWorkspaceDispatches,
    findOpenDispatch,
    listWorkspaceDispatches,
    markReportedByWorker,
    markSubmitted,
  }
}
