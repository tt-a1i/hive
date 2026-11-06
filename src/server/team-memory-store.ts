import { createHash, randomUUID } from 'node:crypto'
import {
  MEMORY_QUERY_MAX_CHARS,
  MEMORY_SEARCH_DEFAULT_LIMIT,
  MEMORY_SEARCH_MAX_LIMIT,
  type MemoryKind,
  type MemoryProcedureRef,
  type MemoryScope,
} from '../shared/team-memory.js'
import type { AgentSummary } from '../shared/types.js'
import { BadRequestError, ConflictError, ForbiddenError } from './http-errors.js'
import type { Database } from './sqlite.js'

export type MemoryStatus = 'active' | 'candidate' | 'archived' | 'rejected'
export type MemorySource = 'manual' | 'dream'
export type MemorySourceType = 'manual' | 'message' | 'dispatch' | 'report' | 'dream' | 'memory'
export type MemoryInjectionContext = 'startup' | 'dispatch' | 'recovery' | 'manual_search'

export interface MemoryActorSnapshot {
  id: string
  name: string
  role: AgentSummary['role']
}

export interface MemoryEntryRecord {
  archivedAt: number | null
  body: string
  confidence: number | null
  createdAt: number
  disabled: boolean
  id: string
  kind: MemoryKind
  lastInjectedAt: number | null
  pinned: boolean
  procedureRef: MemoryProcedureRef | null
  scope: MemoryScope
  source: MemorySource
  status: MemoryStatus
  tags: string[]
  updatedAt: number
  workspaceId: string | null
}

export interface MemorySourceRecord {
  actorAgentIdSnapshot: string | null
  actorNameSnapshot: string | null
  actorRoleSnapshot: string | null
  createdAt: number
  excerpt: string | null
  id: string
  memoryId: string
  sourceId: string | null
  sourceSequence: number | null
  sourceType: MemorySourceType
  textHash: string | null
}

export interface MemoryEntryWithSources extends MemoryEntryRecord {
  sources: MemorySourceRecord[]
}

export interface MemorySearchResult extends MemoryEntryWithSources {
  indexName: 'like' | 'trigram' | 'unicode'
  score: number
}

export interface AddMemoryEntryInput {
  supersedesId?: string
  actor: MemoryActorSnapshot
  body: string
  confidence?: number | null
  kind: MemoryKind
  procedureRef?: MemoryProcedureRef | null
  source?: MemorySource
  scope?: MemoryScope
  tags?: string[]
  workspaceId: string
}

export interface LogMemoryInjectionsInput {
  contextType: MemoryInjectionContext
  dispatchId?: string | null
  memoryIds: string[]
  targetAgentIdSnapshot?: string | null
  workspaceId: string
}

export interface MemorySearchOptions {
  includeDisabled?: boolean
  limit?: number
  scopes?: MemoryScope[]
  statuses?: MemoryStatus[]
}

export interface MemoryListOptions {
  limit?: number
  scopes?: MemoryScope[]
  statuses?: MemoryStatus[]
}

export interface MemoryDigestOptions {
  limit?: number
  scopes?: MemoryScope[]
}

export interface MemoryInjectionWithMemory {
  contextType: MemoryInjectionContext
  dispatchId: string | null
  id: string
  injectedAt: number
  memory: MemoryEntryWithSources
  memoryId: string
  targetAgentIdSnapshot: string | null
  workspaceId: string | null
}

export class MemoryEntryNotFoundError extends Error {
  readonly memoryId: string
  readonly workspaceId: string

  constructor(memoryId: string, workspaceId: string) {
    super(`Memory entry not found in workspace: ${memoryId}`)
    this.name = 'MemoryEntryNotFoundError'
    this.memoryId = memoryId
    this.workspaceId = workspaceId
  }
}

export class MemoryEntryStatusError extends Error {
  readonly actualStatus: MemoryStatus
  readonly memoryId: string
  readonly expectedStatus: MemoryStatus | MemoryStatus[]

  constructor(
    memoryId: string,
    expectedStatus: MemoryStatus | MemoryStatus[],
    actualStatus: MemoryStatus
  ) {
    const expected = Array.isArray(expectedStatus) ? expectedStatus.join(' or ') : expectedStatus
    super(`Memory entry ${memoryId} expected status ${expected}, got ${actualStatus}`)
    this.name = 'MemoryEntryStatusError'
    this.memoryId = memoryId
    this.expectedStatus = expectedStatus
    this.actualStatus = actualStatus
  }
}

interface MemoryEntryRow {
  archived_at: number | null
  body: string
  confidence: number | null
  created_at: number
  disabled: number
  fts_rowid: number
  id: string
  kind: MemoryKind
  last_injected_at: number | null
  pinned: number
  ref_id: string | null
  ref_title: string | null
  ref_type: MemoryProcedureRef['type'] | null
  scope: MemoryScope
  source: MemorySource
  status: MemoryStatus
  tags: string | null
  updated_at: number
  workspace_id: string | null
}

interface MemorySearchRow extends MemoryEntryRow {
  index_name: 'like' | 'trigram' | 'unicode'
  score: number
}

interface MemorySourceRow {
  actor_agent_id_snapshot: string | null
  actor_name_snapshot: string | null
  actor_role_snapshot: string | null
  created_at: number
  excerpt: string | null
  id: string
  memory_id: string
  source_id: string | null
  source_sequence: number | null
  source_type: MemorySourceType
  text_hash: string | null
}

interface MemoryInjectionRow {
  context_type: MemoryInjectionContext
  dispatch_id: string | null
  id: string
  injected_at: number
  memory_id: string
  target_agent_id_snapshot: string | null
  workspace_id: string | null
}

const hashText = (text: string) => createHash('sha256').update(text).digest('hex')

const excerptFor = (text: string) => [...text].slice(0, 500).join('')

const clampLimit = (value: number | undefined) => {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return MEMORY_SEARCH_DEFAULT_LIMIT
  }
  return Math.min(value, MEMORY_SEARCH_MAX_LIMIT)
}

const clampDigestLimit = (value: number | undefined) => {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return 20
  return Math.min(value, 50)
}

const clampListLimit = (value: number | undefined) => {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return MEMORY_SEARCH_MAX_LIMIT
  return Math.min(value, MEMORY_SEARCH_MAX_LIMIT)
}

const quoteFtsToken = (value: string) => `"${value.replaceAll('"', '""')}"`

const toSearchTerms = (query: string) => query.trim().split(/\s+/).filter(Boolean)

const toFtsQuery = (query: string) => toSearchTerms(query).map(quoteFtsToken).join(' AND ')

const hasShortTerm = (terms: string[]) => terms.some((term) => [...term].length < 3)

const escapeLike = (value: string) =>
  `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`

const parseTags = (value: string | null) => {
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
}

const normalizeScopes = (scopes: MemoryScope[] | undefined): MemoryScope[] => {
  if (scopes === undefined) return ['workspace']
  const result: MemoryScope[] = []
  for (const scope of scopes) {
    if (!result.includes(scope)) result.push(scope)
  }
  return result
}

const scopePredicate = (
  alias: string,
  workspaceId: string,
  scopes: MemoryScope[] | undefined
): { params: string[]; sql: string } => {
  const prefix = alias ? `${alias}.` : ''
  const clauses: string[] = []
  const params: string[] = []
  for (const scope of normalizeScopes(scopes)) {
    if (scope === 'workspace') {
      clauses.push(`(${prefix}scope = 'workspace' AND ${prefix}workspace_id = ?)`)
      params.push(workspaceId)
    }
    if (scope === 'user') {
      clauses.push(`(${prefix}scope = 'user' AND ${prefix}workspace_id IS NULL)`)
    }
  }
  return { params, sql: clauses.length > 0 ? `(${clauses.join(' OR ')})` : '0 = 1' }
}

const lastInjectedAtForContext = (db: Database, row: MemoryEntryRow, workspaceId?: string) => {
  if (row.scope !== 'user' || !workspaceId) return row.last_injected_at
  return (
    db
      .prepare(
        `SELECT MAX(injected_at) AS last
         FROM memory_injections
         WHERE memory_id = ?
           AND workspace_id = ?`
      )
      .get(row.id, workspaceId) as { last: number | null }
  ).last
}

const toEntryRecord = (
  db: Database,
  row: MemoryEntryRow,
  contextWorkspaceId?: string
): MemoryEntryRecord => ({
  archivedAt: row.archived_at,
  body: row.body,
  confidence: row.confidence,
  createdAt: row.created_at,
  disabled: row.disabled === 1,
  id: row.id,
  kind: row.kind,
  lastInjectedAt: lastInjectedAtForContext(db, row, contextWorkspaceId),
  pinned: row.pinned === 1,
  procedureRef:
    row.ref_type && row.ref_id
      ? {
          id: row.ref_id,
          title: row.ref_title,
          type: row.ref_type,
        }
      : null,
  scope: row.scope,
  source: row.source,
  status: row.status,
  tags: parseTags(row.tags),
  updatedAt: row.updated_at,
  workspaceId: row.workspace_id,
})

const toSourceRecord = (row: MemorySourceRow): MemorySourceRecord => ({
  actorAgentIdSnapshot: row.actor_agent_id_snapshot,
  actorNameSnapshot: row.actor_name_snapshot,
  actorRoleSnapshot: row.actor_role_snapshot,
  createdAt: row.created_at,
  excerpt: row.excerpt,
  id: row.id,
  memoryId: row.memory_id,
  sourceId: row.source_id,
  sourceSequence: row.source_sequence,
  sourceType: row.source_type,
  textHash: row.text_hash,
})

export const createTeamMemoryStore = (db: Database) => {
  const nextFtsRowid = () =>
    (
      db.prepare('SELECT COALESCE(MAX(fts_rowid), 0) + 1 AS next FROM memory_entries').get() as {
        next: number
      }
    ).next

  const listSources = (memoryId: string) =>
    (
      db
        .prepare(
          `SELECT *
           FROM memory_sources
           WHERE memory_id = ?
           ORDER BY created_at ASC, id ASC`
        )
        .all(memoryId) as MemorySourceRow[]
    ).map(toSourceRecord)

  const toEntryWithSources = (
    row: MemoryEntryRow,
    contextWorkspaceId?: string
  ): MemoryEntryWithSources => ({
    ...toEntryRecord(db, row, contextWorkspaceId),
    sources: listSources(row.id),
  })

  const getEntryWithSources = (
    workspaceId: string,
    memoryId: string
  ): MemoryEntryWithSources | undefined => {
    const scope = scopePredicate('', workspaceId, ['workspace', 'user'])
    const row = db
      .prepare(
        `SELECT *
         FROM memory_entries
         WHERE id = ?
           AND ${scope.sql}
         LIMIT 1`
      )
      .get(memoryId, ...scope.params) as MemoryEntryRow | undefined

    if (!row) return undefined

    return toEntryWithSources(row, workspaceId)
  }

  const requireEntryWithSources = (workspaceId: string, memoryId: string) => {
    const entry = getEntryWithSources(workspaceId, memoryId)
    if (!entry) throw new MemoryEntryNotFoundError(memoryId, workspaceId)
    return entry
  }

  const searchFts = (
    table: 'memory_fts' | 'memory_fts_trigram',
    workspaceId: string,
    ftsQuery: string,
    statuses: MemoryStatus[],
    includeDisabled: boolean,
    scopes: MemoryScope[] | undefined
  ) => {
    if (statuses.length === 0) return []
    const indexName = table === 'memory_fts' ? 'unicode' : 'trigram'
    const statusPlaceholders = statuses.map(() => '?').join(', ')
    const scope = scopePredicate('e', workspaceId, scopes)
    return db
      .prepare(
        `SELECT
           e.*,
           ? AS index_name,
           bm25(${table}) AS score
         FROM ${table}
         JOIN memory_entries e ON e.fts_rowid = ${table}.rowid
         WHERE ${table} MATCH ?
           AND ${scope.sql}
           ${includeDisabled ? '' : 'AND e.disabled = 0'}
           AND e.status IN (${statusPlaceholders})`
      )
      .all(indexName, ftsQuery, ...scope.params, ...statuses) as MemorySearchRow[]
  }

  const searchLike = (
    workspaceId: string,
    terms: string[],
    statuses: MemoryStatus[],
    includeDisabled: boolean,
    scopes: MemoryScope[] | undefined
  ) => {
    if (terms.length === 0 || statuses.length === 0) return []
    const predicates = terms
      .map(() => "(e.body LIKE ? ESCAPE '\\' OR COALESCE(e.tags, '') LIKE ? ESCAPE '\\')")
      .join(' AND ')
    const statusPlaceholders = statuses.map(() => '?').join(', ')
    const scope = scopePredicate('e', workspaceId, scopes)
    return db
      .prepare(
        `SELECT
           e.*,
           'like' AS index_name,
           0 AS score
         FROM memory_entries e
         WHERE ${scope.sql}
           ${includeDisabled ? '' : 'AND e.disabled = 0'}
           AND e.status IN (${statusPlaceholders})
           AND ${predicates}`
      )
      .all(
        ...scope.params,
        ...statuses,
        ...terms.flatMap((term) => [escapeLike(term), escapeLike(term)])
      ) as MemorySearchRow[]
  }

  const searchEntries = (
    workspaceId: string,
    query: string,
    options: MemorySearchOptions = {}
  ): MemorySearchResult[] => {
    if ([...query].length > MEMORY_QUERY_MAX_CHARS) return []
    const ftsQuery = toFtsQuery(query)
    if (!ftsQuery) return []

    const terms = toSearchTerms(query)
    const statuses = options.statuses ?? ['active']
    const includeDisabled = options.includeDisabled ?? false
    const rows = [
      ...searchFts('memory_fts', workspaceId, ftsQuery, statuses, includeDisabled, options.scopes),
      ...searchFts(
        'memory_fts_trigram',
        workspaceId,
        ftsQuery,
        statuses,
        includeDisabled,
        options.scopes
      ),
      ...(hasShortTerm(terms)
        ? searchLike(workspaceId, terms, statuses, includeDisabled, options.scopes)
        : []),
    ]
    const byId = new Map<string, MemorySearchRow>()
    for (const row of rows) {
      const previous = byId.get(row.id)
      if (!previous || row.score < previous.score) byId.set(row.id, row)
    }

    return [...byId.values()]
      .sort((a, b) => a.score - b.score || b.updated_at - a.updated_at)
      .slice(0, clampLimit(options.limit))
      .map((row) => ({
        ...toEntryWithSources(row, workspaceId),
        indexName: row.index_name,
        score: row.score,
      }))
  }

  const listEntries = (
    workspaceId: string,
    options: MemoryListOptions = {}
  ): MemoryEntryWithSources[] => {
    const statuses = options.statuses ?? ['active']
    if (statuses.length === 0) return []
    const statusPlaceholders = statuses.map(() => '?').join(', ')
    const scope = scopePredicate('', workspaceId, options.scopes)
    return (
      db
        .prepare(
          `SELECT *
           FROM memory_entries
           WHERE ${scope.sql}
             AND status IN (${statusPlaceholders})
           ORDER BY
             CASE status
               WHEN 'candidate' THEN 0
               WHEN 'active' THEN 1
               WHEN 'archived' THEN 2
               ELSE 3
             END ASC,
             pinned DESC,
             updated_at DESC,
             created_at DESC,
             id ASC
           LIMIT ?`
        )
        .all(...scope.params, ...statuses, clampListLimit(options.limit)) as MemoryEntryRow[]
    ).map((row) => toEntryWithSources(row, workspaceId))
  }

  const listAllEntries = (
    workspaceId: string,
    options: Pick<MemoryListOptions, 'scopes'> = {}
  ): MemoryEntryWithSources[] => {
    const scope = scopePredicate('', workspaceId, options.scopes)
    return (
      db
        .prepare(
          `SELECT *
           FROM memory_entries
           WHERE ${scope.sql}
           ORDER BY
             CASE status
               WHEN 'candidate' THEN 0
               WHEN 'active' THEN 1
               WHEN 'archived' THEN 2
               ELSE 3
             END ASC,
             pinned DESC,
             updated_at DESC,
             created_at DESC,
             id ASC`
        )
        .all(...scope.params) as MemoryEntryRow[]
    ).map((row) => toEntryWithSources(row, workspaceId))
  }

  const listDigestEntries = (
    workspaceId: string,
    options: MemoryDigestOptions = {}
  ): MemoryEntryWithSources[] => {
    const scope = scopePredicate('', workspaceId, options.scopes)
    return (
      db
        .prepare(
          `SELECT *
           FROM memory_entries
           WHERE ${scope.sql}
             AND status = 'active'
             AND disabled = 0
           ORDER BY
             CASE scope WHEN 'user' THEN 0 ELSE 1 END ASC,
             pinned DESC,
             CASE source WHEN 'manual' THEN 0 ELSE 1 END ASC,
             COALESCE(confidence, 0) DESC,
             updated_at DESC,
             created_at DESC,
             id ASC
           LIMIT ?`
        )
        .all(...scope.params, clampDigestLimit(options.limit)) as MemoryEntryRow[]
    ).map((row) => toEntryWithSources(row, workspaceId))
  }

  const listExportEntries = (workspaceId: string): MemoryEntryWithSources[] =>
    (
      db
        .prepare(
          `SELECT *
           FROM memory_entries
           WHERE scope = 'workspace'
             AND workspace_id = ?
             AND status = 'active'
           ORDER BY
             kind ASC,
             pinned DESC,
             CASE source WHEN 'manual' THEN 0 ELSE 1 END ASC,
             COALESCE(confidence, 0) DESC,
             updated_at DESC,
             created_at DESC,
             id ASC`
        )
        .all(workspaceId) as MemoryEntryRow[]
    ).map((row) => toEntryWithSources(row, workspaceId))

  const requireProcedureRefForProcedureKind = (
    kind: MemoryKind,
    procedureRef: MemoryProcedureRef | null
  ) => {
    if (kind === 'procedure_ref' && !procedureRef) {
      throw new Error('procedure_ref memory entries require procedureRef')
    }
  }

  const addEntry = (input: AddMemoryEntryInput): MemoryEntryWithSources => {
    const id = randomUUID()
    const sourceId = randomUUID()
    const now = Date.now()
    const status: MemoryStatus = input.actor.role === 'orchestrator' ? 'active' : 'candidate'
    const source = input.source ?? 'manual'
    const confidence = input.confidence ?? (source === 'manual' ? 1 : null)
    const tags = JSON.stringify(input.tags ?? [])
    const scope = input.scope ?? 'workspace'
    const entryWorkspaceId = scope === 'workspace' ? input.workspaceId : null
    const procedureRef = input.procedureRef ?? null
    requireProcedureRefForProcedureKind(input.kind, procedureRef)

    db.transaction(() => {
      if (input.supersedesId !== undefined) {
        if (input.actor.role !== 'orchestrator')
          throw new ForbiddenError('Only the Orchestrator may supersede decisions')
        if (input.kind !== 'decision' || scope !== 'workspace')
          throw new BadRequestError('Supersession requires a workspace decision')
        const previous = getEntryWithSources(input.workspaceId, input.supersedesId)
        if (!previous || previous.workspaceId !== input.workspaceId)
          throw new ConflictError('Decision does not exist in this workspace')
        if (previous.kind !== 'decision' || previous.status !== 'active')
          throw new ConflictError('Only active decisions may be superseded')
        db.prepare(
          "UPDATE memory_entries SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?"
        ).run(now, now, previous.id)
      }
      const ftsRowid = nextFtsRowid()
      db.prepare(
        `INSERT INTO memory_entries (
          id,
          workspace_id,
          scope,
          fts_rowid,
          kind,
          body,
          tags,
          status,
          source,
          confidence,
          pinned,
          disabled,
          created_at,
          updated_at,
          archived_at,
          last_injected_at,
          ref_type,
          ref_id,
          ref_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, NULL, ?, ?, ?)`
      ).run(
        id,
        entryWorkspaceId,
        scope,
        ftsRowid,
        input.kind,
        input.body,
        tags,
        status,
        source,
        confidence,
        now,
        now,
        procedureRef?.type ?? null,
        procedureRef?.id ?? null,
        procedureRef?.title ?? null
      )

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
        ) VALUES (?, ?, 'manual', NULL, NULL, ?, ?, ?, ?, ?, ?)`
      ).run(
        sourceId,
        id,
        excerptFor(input.body),
        hashText(input.body),
        input.actor.id,
        input.actor.name,
        input.actor.role,
        now
      )
      if (input.supersedesId !== undefined) {
        db.prepare(`INSERT INTO memory_sources
          (id, memory_id, source_type, source_id, excerpt, actor_agent_id_snapshot,
           actor_name_snapshot, actor_role_snapshot, created_at)
          VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?)`).run(
          randomUUID(),
          id,
          input.supersedesId,
          excerptFor(requireEntryWithSources(input.workspaceId, input.supersedesId).body),
          input.actor.id,
          input.actor.name,
          input.actor.role,
          now
        )
      }
    })()

    const created = getEntryWithSources(input.workspaceId, id)
    if (!created) throw new Error(`Memory entry disappeared after insert: ${id}`)
    return created
  }

  const logInjections = (input: LogMemoryInjectionsInput) => {
    if (input.memoryIds.length === 0) return []
    const injectedAt = Date.now()
    const ids = input.memoryIds.map(() => randomUUID())

    db.transaction(() => {
      const scope = scopePredicate('', input.workspaceId, ['workspace', 'user'])
      for (const [index, memoryId] of input.memoryIds.entries()) {
        const memory = db
          .prepare(
            `SELECT id
             FROM memory_entries
             WHERE id = ?
               AND ${scope.sql}
             LIMIT 1`
          )
          .get(memoryId, ...scope.params) as { id: string } | undefined
        if (!memory) {
          throw new MemoryEntryNotFoundError(memoryId, input.workspaceId)
        }

        db.prepare(
          `INSERT INTO memory_injections (
            id,
            memory_id,
            workspace_id,
            target_agent_id_snapshot,
            context_type,
            dispatch_id,
            injected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          ids[index] as string,
          memoryId,
          input.workspaceId,
          input.targetAgentIdSnapshot ?? null,
          input.contextType,
          input.dispatchId ?? null,
          injectedAt
        )
        db.prepare(
          `UPDATE memory_entries
           SET last_injected_at = ?
           WHERE id = ?`
        ).run(injectedAt, memoryId)
      }
    })()

    return ids
  }

  const deleteInjections = (injectionIds: string[]) => {
    if (injectionIds.length === 0) return
    const placeholders = injectionIds.map(() => '?').join(', ')

    db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT DISTINCT memory_id, workspace_id
           FROM memory_injections
           WHERE id IN (${placeholders})`
        )
        .all(...injectionIds) as Array<{ memory_id: string; workspace_id: string | null }>

      db.prepare(`DELETE FROM memory_injections WHERE id IN (${placeholders})`).run(...injectionIds)

      for (const row of rows) {
        db.prepare(
          `UPDATE memory_entries
           SET last_injected_at = (
             SELECT MAX(injected_at)
             FROM memory_injections
             WHERE memory_id = ?
           )
           WHERE id = ?`
        ).run(row.memory_id, row.memory_id)
      }
    })()
  }

  const archiveEntry = (workspaceId: string, memoryId: string) => {
    const current = requireEntryWithSources(workspaceId, memoryId)
    if (current.status === 'archived') return current
    if (current.status !== 'active') {
      throw new MemoryEntryStatusError(memoryId, 'active', current.status)
    }
    const now = Date.now()
    const scope = scopePredicate('', workspaceId, ['workspace', 'user'])
    const result = db
      .prepare(
        `UPDATE memory_entries
         SET status = 'archived',
             archived_at = ?,
             updated_at = ?
         WHERE id = ?
           AND ${scope.sql}
           AND status = 'active'`
      )
      .run(now, now, memoryId, ...scope.params)
    if (result.changes === 0) throw new MemoryEntryNotFoundError(memoryId, workspaceId)
    return requireEntryWithSources(workspaceId, memoryId)
  }

  const approveCandidate = (workspaceId: string, memoryId: string) => {
    const current = requireEntryWithSources(workspaceId, memoryId)
    if (current.status !== 'candidate') {
      throw new MemoryEntryStatusError(memoryId, 'candidate', current.status)
    }
    const now = Date.now()
    const scope = scopePredicate('', workspaceId, ['workspace', 'user'])
    const result = db
      .prepare(
        `UPDATE memory_entries
         SET status = 'active',
             archived_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND ${scope.sql}
           AND status = 'candidate'`
      )
      .run(now, memoryId, ...scope.params)
    if (result.changes === 0) throw new MemoryEntryNotFoundError(memoryId, workspaceId)
    return requireEntryWithSources(workspaceId, memoryId)
  }

  const rejectCandidate = (workspaceId: string, memoryId: string) => {
    const current = requireEntryWithSources(workspaceId, memoryId)
    if (current.status !== 'candidate') {
      throw new MemoryEntryStatusError(memoryId, 'candidate', current.status)
    }
    const now = Date.now()
    const scope = scopePredicate('', workspaceId, ['workspace', 'user'])
    const result = db
      .prepare(
        `UPDATE memory_entries
         SET status = 'rejected',
             updated_at = ?
         WHERE id = ?
           AND ${scope.sql}
           AND status = 'candidate'`
      )
      .run(now, memoryId, ...scope.params)
    if (result.changes === 0) throw new MemoryEntryNotFoundError(memoryId, workspaceId)
    return requireEntryWithSources(workspaceId, memoryId)
  }

  const setPinned = (workspaceId: string, memoryId: string, pinned: boolean) => {
    const current = requireEntryWithSources(workspaceId, memoryId)
    if (current.status !== 'active') {
      throw new MemoryEntryStatusError(memoryId, 'active', current.status)
    }
    const now = Date.now()
    const scope = scopePredicate('', workspaceId, ['workspace', 'user'])
    const result = db
      .prepare(
        `UPDATE memory_entries
         SET pinned = ?,
             updated_at = ?
         WHERE id = ?
           AND ${scope.sql}
           AND status = 'active'`
      )
      .run(pinned ? 1 : 0, now, memoryId, ...scope.params)
    if (result.changes === 0) throw new MemoryEntryNotFoundError(memoryId, workspaceId)
    return requireEntryWithSources(workspaceId, memoryId)
  }

  const setDisabled = (workspaceId: string, memoryId: string, disabled: boolean) => {
    const current = requireEntryWithSources(workspaceId, memoryId)
    if (current.status !== 'active') {
      throw new MemoryEntryStatusError(memoryId, 'active', current.status)
    }
    const now = Date.now()
    const scope = scopePredicate('', workspaceId, ['workspace', 'user'])
    const result = db
      .prepare(
        `UPDATE memory_entries
         SET disabled = ?,
             updated_at = ?
         WHERE id = ?
           AND ${scope.sql}
           AND status = 'active'`
      )
      .run(disabled ? 1 : 0, now, memoryId, ...scope.params)
    if (result.changes === 0) throw new MemoryEntryNotFoundError(memoryId, workspaceId)
    return requireEntryWithSources(workspaceId, memoryId)
  }

  const deleteWorkspaceMemories = (workspaceId: string) => {
    db.transaction(() => {
      db.prepare('DELETE FROM memory_injections WHERE workspace_id = ?').run(workspaceId)
      const rows = db
        .prepare(
          `SELECT id
           FROM memory_entries
           WHERE scope = 'workspace'
             AND workspace_id = ?`
        )
        .all(workspaceId) as Array<{ id: string }>

      for (const row of rows) {
        db.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run(row.id)
        db.prepare('DELETE FROM memory_injections WHERE memory_id = ?').run(row.id)
      }
      db.prepare(
        `DELETE FROM memory_entries
         WHERE scope = 'workspace'
           AND workspace_id = ?`
      ).run(workspaceId)
    })()
  }

  const listInjectionsForDispatch = (
    workspaceId: string,
    dispatchId: string
  ): MemoryInjectionWithMemory[] =>
    (
      db
        .prepare(
          `SELECT *
           FROM memory_injections
           WHERE workspace_id = ?
             AND dispatch_id = ?
           ORDER BY injected_at ASC, id ASC`
        )
        .all(workspaceId, dispatchId) as MemoryInjectionRow[]
    ).map((row) => ({
      contextType: row.context_type,
      dispatchId: row.dispatch_id,
      id: row.id,
      injectedAt: row.injected_at,
      memory: requireEntryWithSources(workspaceId, row.memory_id),
      memoryId: row.memory_id,
      targetAgentIdSnapshot: row.target_agent_id_snapshot,
      workspaceId: row.workspace_id,
    }))

  const listInjections = (workspaceId: string, limit = 200): MemoryInjectionWithMemory[] =>
    (
      db
        .prepare(
          `SELECT *
           FROM memory_injections
           WHERE workspace_id = ?
           ORDER BY injected_at DESC, id DESC
           LIMIT ?`
        )
        .all(workspaceId, Math.min(Math.max(Math.trunc(limit), 0), 1000)) as MemoryInjectionRow[]
    ).map((row) => ({
      contextType: row.context_type,
      dispatchId: row.dispatch_id,
      id: row.id,
      injectedAt: row.injected_at,
      memory: requireEntryWithSources(workspaceId, row.memory_id),
      memoryId: row.memory_id,
      targetAgentIdSnapshot: row.target_agent_id_snapshot,
      workspaceId: row.workspace_id,
    }))

  return {
    addEntry,
    approveCandidate,
    archiveEntry,
    deleteWorkspaceMemories,
    deleteInjections,
    getEntryWithSources,
    listDigestEntries,
    listExportEntries,
    listAllEntries,
    listEntries,
    listInjections,
    listInjectionsForDispatch,
    logInjections,
    rejectCandidate,
    searchEntries,
    setDisabled,
    setPinned,
  }
}
