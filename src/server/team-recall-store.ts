import { RECALL_QUERY_MAX_CHARS } from '../shared/team-recall.js'
import type { Database } from './sqlite.js'

export interface RecallContextMessage {
  createdAt: number
  fromAgentId: string | null
  sourceSequence: number
  text: string
  toAgentId: string | null
  type: string
  workerId: string
}

export interface RecallResult {
  context: RecallContextMessage[]
  createdAt: number
  dispatchId: string | null
  dispatchStatus: string | null
  fromAgentId: string | null
  indexName: 'like' | 'trigram' | 'unicode'
  messageType: string | null
  reportText: string | null
  score: number
  sourceSequence: number
  sourceType: 'dispatch' | 'message'
  text: string
  toAgentId: string | null
  workerId: string | null
}

export interface RecallOptions {
  limit?: number
  window?: number
}

interface RecallRow {
  created_at: number
  dispatch_id: string | null
  dispatch_status: string | null
  from_agent_id: string | null
  index_name: 'like' | 'trigram' | 'unicode'
  message_type: string | null
  report_text: string | null
  score: number
  source_sequence: number
  source_type: 'dispatch' | 'message'
  text: string | null
  to_agent_id: string | null
  worker_id: string | null
}

interface ContextRow {
  created_at: number
  from_agent_id: string | null
  sequence: number
  text: string | null
  to_agent_id: string | null
  type: string
  worker_id: string
}

const DEFAULT_LIMIT = 10
const DEFAULT_WINDOW = 2
const MAX_LIMIT = 50
const MAX_WINDOW = 10

const clampInt = (value: number | undefined, fallback: number, max: number) => {
  if (value === undefined || !Number.isInteger(value) || value < 0) return fallback
  return Math.min(value, max)
}

const quoteFtsToken = (value: string) => `"${value.replaceAll('"', '""')}"`

const toSearchTerms = (query: string) => query.trim().split(/\s+/).filter(Boolean)

const toFtsQuery = (query: string) => toSearchTerms(query).map(quoteFtsToken).join(' AND ')

const hasShortTerm = (terms: string[]) => terms.some((term) => [...term].length < 3)

const escapeLike = (value: string) =>
  `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`

const mapContext = (row: ContextRow): RecallContextMessage => ({
  createdAt: row.created_at,
  fromAgentId: row.from_agent_id,
  sourceSequence: row.sequence,
  text: row.text ?? '',
  toAgentId: row.to_agent_id,
  type: row.type,
  workerId: row.worker_id,
})

const mapRow = (row: RecallRow): RecallResult => ({
  context: [],
  createdAt: row.created_at,
  dispatchId: row.dispatch_id,
  dispatchStatus: row.dispatch_status,
  fromAgentId: row.from_agent_id,
  indexName: row.index_name,
  messageType: row.message_type,
  reportText: row.report_text,
  score: row.score,
  sourceSequence: row.source_sequence,
  sourceType: row.source_type,
  text: row.text ?? '',
  toAgentId: row.to_agent_id,
  workerId: row.worker_id,
})

export const createTeamRecallStore = (db: Database) => {
  const searchMessages = (
    table: 'messages_fts' | 'messages_fts_trigram',
    workspaceId: string,
    ftsQuery: string
  ) => {
    const indexName = table === 'messages_fts' ? 'unicode' : 'trigram'
    return db
      .prepare(
        `SELECT
           'message' AS source_type,
           ? AS index_name,
           m.sequence AS source_sequence,
           NULL AS dispatch_id,
           NULL AS dispatch_status,
           m.type AS message_type,
           m.worker_id,
           m.from_agent_id,
           m.to_agent_id,
           m.text,
           NULL AS report_text,
           m.created_at,
           bm25(${table}) AS score
         FROM ${table}
         JOIN messages m ON m.sequence = ${table}.rowid
         WHERE ${table} MATCH ?
           AND m.workspace_id = ?`
      )
      .all(indexName, ftsQuery, workspaceId)
  }

  const searchDispatches = (
    table: 'dispatches_fts' | 'dispatches_fts_trigram',
    workspaceId: string,
    ftsQuery: string
  ) => {
    const indexName = table === 'dispatches_fts' ? 'unicode' : 'trigram'
    return db
      .prepare(
        `SELECT
           'dispatch' AS source_type,
           ? AS index_name,
           d.sequence AS source_sequence,
           d.id AS dispatch_id,
           d.status AS dispatch_status,
           NULL AS message_type,
           NULL AS worker_id,
           d.from_agent_id,
           d.to_agent_id,
           d.text,
           d.report_text,
           COALESCE(d.reported_at, d.submitted_at, d.created_at) AS created_at,
           bm25(${table}) AS score
         FROM ${table}
         JOIN dispatches d ON d.sequence = ${table}.rowid
         WHERE ${table} MATCH ?
           AND d.workspace_id = ?`
      )
      .all(indexName, ftsQuery, workspaceId)
  }

  const searchMessagesLike = (workspaceId: string, terms: string[]) => {
    if (terms.length === 0) return []
    const predicates = terms.map(() => "m.text LIKE ? ESCAPE '\\'").join(' AND ')
    return db
      .prepare(
        `SELECT
           'message' AS source_type,
           'like' AS index_name,
           m.sequence AS source_sequence,
           NULL AS dispatch_id,
           NULL AS dispatch_status,
           m.type AS message_type,
           m.worker_id,
           m.from_agent_id,
           m.to_agent_id,
           m.text,
           NULL AS report_text,
           m.created_at,
           0 AS score
         FROM messages m
         WHERE m.workspace_id = ?
           AND ${predicates}`
      )
      .all(workspaceId, ...terms.map(escapeLike))
  }

  const searchDispatchesLike = (workspaceId: string, terms: string[]) => {
    if (terms.length === 0) return []
    const predicates = terms
      .map(() => "(d.text LIKE ? ESCAPE '\\' OR d.report_text LIKE ? ESCAPE '\\')")
      .join(' AND ')
    return db
      .prepare(
        `SELECT
           'dispatch' AS source_type,
           'like' AS index_name,
           d.sequence AS source_sequence,
           d.id AS dispatch_id,
           d.status AS dispatch_status,
           NULL AS message_type,
           NULL AS worker_id,
           d.from_agent_id,
           d.to_agent_id,
           d.text,
           d.report_text,
           COALESCE(d.reported_at, d.submitted_at, d.created_at) AS created_at,
           0 AS score
         FROM dispatches d
         WHERE d.workspace_id = ?
           AND ${predicates}`
      )
      .all(workspaceId, ...terms.flatMap((term) => [escapeLike(term), escapeLike(term)]))
  }

  const listContext = (workspaceId: string, sequence: number, window: number) => {
    if (window <= 0) return []
    const previousRows = db
      .prepare(
        `SELECT sequence, worker_id, type, from_agent_id, to_agent_id, text, created_at
         FROM messages
         WHERE workspace_id = ?
           AND sequence < ?
         ORDER BY sequence DESC
         LIMIT ?`
      )
      .all(workspaceId, sequence, window) as ContextRow[]
    const anchorRow = db
      .prepare(
        `SELECT sequence, worker_id, type, from_agent_id, to_agent_id, text, created_at
         FROM messages
         WHERE workspace_id = ?
           AND sequence = ?
         LIMIT 1`
      )
      .get(workspaceId, sequence) as ContextRow | undefined
    const nextRows = db
      .prepare(
        `SELECT sequence, worker_id, type, from_agent_id, to_agent_id, text, created_at
         FROM messages
         WHERE workspace_id = ?
           AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`
      )
      .all(workspaceId, sequence, window) as ContextRow[]
    const rows = [...previousRows.slice().reverse(), ...(anchorRow ? [anchorRow] : []), ...nextRows]
    return rows.map(mapContext)
  }

  const recallMessages = (
    workspaceId: string,
    query: string,
    options: RecallOptions = {}
  ): RecallResult[] => {
    if ([...query].length > RECALL_QUERY_MAX_CHARS) return []
    const ftsQuery = toFtsQuery(query)
    if (!ftsQuery) return []

    const terms = toSearchTerms(query)
    const likeRows = hasShortTerm(terms)
      ? [...searchMessagesLike(workspaceId, terms), ...searchDispatchesLike(workspaceId, terms)]
      : []
    const limit = clampInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT)
    const window = clampInt(options.window, DEFAULT_WINDOW, MAX_WINDOW)
    const byKey = new Map<string, RecallResult>()
    const rows = [
      ...searchMessages('messages_fts', workspaceId, ftsQuery),
      ...searchMessages('messages_fts_trigram', workspaceId, ftsQuery),
      ...searchDispatches('dispatches_fts', workspaceId, ftsQuery),
      ...searchDispatches('dispatches_fts_trigram', workspaceId, ftsQuery),
      ...likeRows,
    ] as RecallRow[]

    for (const row of rows) {
      const result = mapRow(row)
      const key = `${result.sourceType}:${result.sourceSequence}`
      const previous = byKey.get(key)
      if (!previous || result.score < previous.score) {
        byKey.set(key, result)
      }
    }

    return [...byKey.values()]
      .sort((a, b) => a.score - b.score || b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((result) =>
        result.sourceType === 'message'
          ? { ...result, context: listContext(workspaceId, result.sourceSequence, window) }
          : result
      )
  }

  return {
    recallMessages,
  }
}
