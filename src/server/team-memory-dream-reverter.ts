import { isMemoryKind, isMemoryProcedureRefType } from '../shared/team-memory.js'
import type { Database } from './sqlite.js'
import {
  type DreamRunRecord,
  type DreamRunRevertBlob,
  type DreamRunRow,
  type MemoryEntryRow,
  type MemorySourceRow,
  toDreamRunRecord,
} from './team-memory-dream-types.js'

type RevertableDreamRunRecord = DreamRunRecord & { revertBlob: DreamRunRevertBlob }

const MEMORY_STATUSES = new Set(['active', 'candidate', 'archived', 'rejected'])
const MEMORY_SOURCES = new Set(['manual', 'dream'])
const MEMORY_SOURCE_TYPES = new Set(['manual', 'message', 'dispatch', 'report', 'dream', 'memory'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasValidMemoryEntryShape = (value: unknown): value is MemoryEntryRow => {
  if (!isObject(value)) return false
  return (
    (typeof value.archived_at === 'number' || value.archived_at === null) &&
    typeof value.id === 'string' &&
    typeof value.body === 'string' &&
    (typeof value.confidence === 'number' || value.confidence === null) &&
    typeof value.created_at === 'number' &&
    (value.disabled === 0 || value.disabled === 1) &&
    typeof value.fts_rowid === 'number' &&
    isMemoryKind(value.kind) &&
    (typeof value.last_injected_at === 'number' || value.last_injected_at === null) &&
    (value.pinned === 0 || value.pinned === 1) &&
    (value.ref_id === undefined || typeof value.ref_id === 'string' || value.ref_id === null) &&
    (value.ref_title === undefined ||
      typeof value.ref_title === 'string' ||
      value.ref_title === null) &&
    (value.ref_type === undefined ||
      value.ref_type === null ||
      isMemoryProcedureRefType(value.ref_type)) &&
    value.scope === 'workspace' &&
    typeof value.source === 'string' &&
    MEMORY_SOURCES.has(value.source) &&
    typeof value.status === 'string' &&
    MEMORY_STATUSES.has(value.status) &&
    (typeof value.tags === 'string' || value.tags === null) &&
    typeof value.updated_at === 'number' &&
    (typeof value.workspace_id === 'string' || value.workspace_id === null)
  )
}

const hasValidMemorySourceShape = (value: unknown): value is MemorySourceRow => {
  if (!isObject(value)) return false
  return (
    (typeof value.actor_agent_id_snapshot === 'string' || value.actor_agent_id_snapshot === null) &&
    (typeof value.actor_name_snapshot === 'string' || value.actor_name_snapshot === null) &&
    (typeof value.actor_role_snapshot === 'string' || value.actor_role_snapshot === null) &&
    typeof value.id === 'string' &&
    typeof value.memory_id === 'string' &&
    (typeof value.excerpt === 'string' || value.excerpt === null) &&
    (typeof value.source_id === 'string' || value.source_id === null) &&
    (typeof value.source_sequence === 'number' || value.source_sequence === null) &&
    typeof value.source_type === 'string' &&
    MEMORY_SOURCE_TYPES.has(value.source_type) &&
    (typeof value.text_hash === 'string' || value.text_hash === null) &&
    typeof value.created_at === 'number'
  )
}

const hasValidRevertBlobShape = (value: unknown): value is DreamRunRevertBlob => {
  if (!isObject(value)) return false
  if (
    !Array.isArray(value.added_entry_ids) ||
    !value.added_entry_ids.every((id) => typeof id === 'string')
  ) {
    return false
  }
  if (!Array.isArray(value.prior_entries)) return false
  return value.prior_entries.every((prior) => {
    if (!isObject(prior)) return false
    if (!hasValidMemoryEntryShape(prior.entry)) return false
    return Array.isArray(prior.sources) && prior.sources.every(hasValidMemorySourceShape)
  })
}

export class DreamRunNotFoundError extends Error {
  readonly runId: string
  readonly workspaceId: string

  constructor(workspaceId: string, runId: string) {
    super(`Dream run not found: ${runId}`)
    this.name = 'DreamRunNotFoundError'
    this.workspaceId = workspaceId
    this.runId = runId
  }
}

export class DreamRunRevertDataError extends Error {
  readonly runId: string
  readonly workspaceId: string

  constructor(workspaceId: string, runId: string, message: string) {
    super(message)
    this.name = 'DreamRunRevertDataError'
    this.workspaceId = workspaceId
    this.runId = runId
  }
}

export class DreamRunRevertStatusError extends Error {
  readonly actualStatus: DreamRunRow['status']
  readonly expectedStatus = 'completed'
  readonly runId: string
  readonly workspaceId: string

  constructor(workspaceId: string, runId: string, actualStatus: DreamRunRow['status']) {
    super(`Dream run has status ${actualStatus}; expected completed`)
    this.name = 'DreamRunRevertStatusError'
    this.workspaceId = workspaceId
    this.runId = runId
    this.actualStatus = actualStatus
  }
}

export const createDreamRunReverter = (db: Database) => {
  const getRunRow = (workspaceId: string, runId: string) =>
    db
      .prepare(
        `SELECT *
         FROM dream_runs
         WHERE id = ?
           AND workspace_id = ?
         LIMIT 1`
      )
      .get(runId, workspaceId) as DreamRunRow | undefined

  const requireCompletedRun = (workspaceId: string, runId: string) => {
    const row = getRunRow(workspaceId, runId)
    if (!row) throw new DreamRunNotFoundError(workspaceId, runId)
    if (row.status !== 'completed') {
      throw new DreamRunRevertStatusError(workspaceId, runId, row.status)
    }
    return row
  }

  const assertPriorEntry = (workspaceId: string, runId: string, entry: MemoryEntryRow) => {
    if (entry.scope !== 'workspace' || entry.workspace_id !== workspaceId) {
      throw new DreamRunRevertDataError(workspaceId, runId, 'Dream revert entry is out of scope')
    }
  }

  const restoreSource = (
    workspaceId: string,
    runId: string,
    memoryId: string,
    source: MemorySourceRow
  ) => {
    if (source.memory_id !== memoryId) {
      throw new DreamRunRevertDataError(workspaceId, runId, 'Dream revert source is out of scope')
    }
    db.prepare(
      `INSERT INTO memory_sources (
        id,
        memory_id,
        source_type,
        source_id,
        source_sequence,
        excerpt,
        text_hash,
        actor_agent_id_snapshot,
        actor_name_snapshot,
        actor_role_snapshot,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      source.id,
      source.memory_id,
      source.source_type,
      source.source_id,
      source.source_sequence,
      source.excerpt,
      source.text_hash,
      source.actor_agent_id_snapshot,
      source.actor_name_snapshot,
      source.actor_role_snapshot,
      source.created_at
    )
  }

  const restorePriorEntry = (
    workspaceId: string,
    runId: string,
    runStartedAt: number,
    prior: { entry: MemoryEntryRow; sources: MemorySourceRow[] }
  ) => {
    assertPriorEntry(workspaceId, runId, prior.entry)
    // A stale Dream revert must not undo a later decision supersession.
    const laterSupersession = db
      .prepare(
        `SELECT 1
         FROM memory_sources AS supersession
         JOIN memory_entries AS replacement ON replacement.id = supersession.memory_id
         WHERE supersession.source_type = 'memory'
           AND supersession.source_id = ?
           AND supersession.created_at >= ?
           AND replacement.workspace_id = ?
           AND replacement.scope = 'workspace'
         LIMIT 1`
      )
      .get(prior.entry.id, runStartedAt, workspaceId)
    if (laterSupersession) return

    const result = db
      .prepare(
        `UPDATE memory_entries
         SET workspace_id = ?,
             scope = ?,
             fts_rowid = ?,
             kind = ?,
             body = ?,
             tags = ?,
             status = ?,
             source = ?,
             confidence = ?,
             pinned = ?,
             disabled = ?,
             created_at = ?,
             updated_at = ?,
             archived_at = ?,
             last_injected_at = ?,
             ref_type = ?,
             ref_id = ?,
             ref_title = ?
         WHERE id = ?
           AND workspace_id = ?
           AND scope = 'workspace'`
      )
      .run(
        prior.entry.workspace_id,
        prior.entry.scope,
        prior.entry.fts_rowid,
        prior.entry.kind,
        prior.entry.body,
        prior.entry.tags,
        prior.entry.status,
        prior.entry.source,
        prior.entry.confidence,
        prior.entry.pinned,
        prior.entry.disabled,
        prior.entry.created_at,
        prior.entry.updated_at,
        prior.entry.archived_at,
        prior.entry.last_injected_at,
        prior.entry.ref_type ?? null,
        prior.entry.ref_id ?? null,
        prior.entry.ref_title ?? null,
        prior.entry.id,
        workspaceId
      )
    if (result.changes === 0) {
      throw new DreamRunRevertDataError(workspaceId, runId, 'Dream revert prior entry is missing')
    }

    db.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run(prior.entry.id)
    for (const source of prior.sources) restoreSource(workspaceId, runId, prior.entry.id, source)
  }

  const archiveAddedEntry = (workspaceId: string, runId: string, memoryId: string, now: number) => {
    const result = db
      .prepare(
        `UPDATE memory_entries
         SET status = 'archived',
             archived_at = COALESCE(archived_at, ?),
             updated_at = ?
         WHERE id = ?
           AND workspace_id = ?
           AND scope = 'workspace'
           AND source = 'dream'`
      )
      .run(now, now, memoryId, workspaceId)
    if (result.changes === 0) {
      throw new DreamRunRevertDataError(workspaceId, runId, 'Dream added entry is missing')
    }
  }

  const parseCompletedRun = (
    workspaceId: string,
    runId: string,
    row: DreamRunRow
  ): RevertableDreamRunRecord => {
    try {
      const run = toDreamRunRecord(row)
      if (!run.revertBlob || !hasValidRevertBlobShape(run.revertBlob)) {
        throw new DreamRunRevertDataError(workspaceId, runId, 'Dream run has no revert data')
      }
      return run as RevertableDreamRunRecord
    } catch (error) {
      if (error instanceof DreamRunRevertDataError) throw error
      throw new DreamRunRevertDataError(workspaceId, runId, 'Dream run revert data is invalid')
    }
  }

  const revertRunTransaction = db.transaction(
    (workspaceId: string, runId: string): DreamRunRecord => {
      const run = parseCompletedRun(workspaceId, runId, requireCompletedRun(workspaceId, runId))

      const now = Date.now()
      for (const prior of run.revertBlob.prior_entries) {
        restorePriorEntry(workspaceId, runId, run.startedAt, prior)
      }
      for (const memoryId of run.revertBlob.added_entry_ids) {
        archiveAddedEntry(workspaceId, runId, memoryId, now)
      }

      const result = db
        .prepare(
          `UPDATE dream_runs
           SET status = 'reverted',
               finished_at = ?
           WHERE id = ?
             AND workspace_id = ?
             AND status = 'completed'`
        )
        .run(now, runId, workspaceId)
      if (result.changes === 0) {
        throw new DreamRunRevertStatusError(workspaceId, runId, run.status)
      }

      const reverted = getRunRow(workspaceId, runId)
      if (!reverted) throw new DreamRunNotFoundError(workspaceId, runId)
      return toDreamRunRecord(reverted)
    }
  )

  const revertRun = (workspaceId: string, runId: string) => revertRunTransaction(workspaceId, runId)

  return { revertRun }
}
