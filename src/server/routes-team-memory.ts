import {
  isMemoryKind,
  isMemoryProcedureRefType,
  isMemoryScope,
  MEMORY_BODY_MAX_CHARS,
  MEMORY_KINDS,
  MEMORY_PROCEDURE_REF_ID_MAX_CHARS,
  MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS,
  MEMORY_PROCEDURE_REF_TYPES,
  MEMORY_QUERY_MAX_CHARS,
  MEMORY_SCOPES,
  MEMORY_SEARCH_MAX_LIMIT,
  MEMORY_TAG_MAX_CHARS,
  MEMORY_TAG_MAX_COUNT,
  type MemoryKind,
  type MemoryProcedureRef,
  type MemoryScope,
} from '../shared/team-memory.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { serializeDreamRun } from './team-memory-dream-http-serializers.js'
import { DreamRunNotFoundError, DreamRunValidationError } from './team-memory-dream-store.js'
import {
  serializeMemoryEntry,
  serializeMemorySearchResult,
} from './team-memory-http-serializers.js'
import { MemoryEntryStatusError } from './team-memory-store.js'

interface TeamMemoryAuthBody {
  from_agent_id?: unknown
  project_id?: unknown
  token?: unknown
}

interface TeamMemoryAddBody extends TeamMemoryAuthBody {
  supersedes_id?: unknown
  body?: unknown
  kind?: unknown
  procedure_ref?: unknown
  scope?: unknown
  tags?: unknown
}

interface TeamMemoryShowBody extends TeamMemoryAuthBody {
  memory_id?: unknown
}

interface TeamMemorySearchBody extends TeamMemoryAuthBody {
  limit?: unknown
  query?: unknown
  scope?: unknown
}

interface TeamMemoryForgetBody extends TeamMemoryAuthBody {
  memory_id?: unknown
}

interface TeamMemoryDreamShowBody extends TeamMemoryAuthBody {
  run_id?: unknown
}

interface TeamMemoryApplyBody extends TeamMemoryAuthBody {
  ops?: unknown
  run_id?: unknown
}

const requireNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  return value.trim()
}

const requireMemoryBody = (value: unknown) => {
  const body = requireNonEmptyString(value, 'body')
  if ([...body].length > MEMORY_BODY_MAX_CHARS) {
    throw new BadRequestError(`body must be ${MEMORY_BODY_MAX_CHARS} characters or fewer`)
  }
  return body
}

const requireMemoryQuery = (value: unknown) => {
  const query = requireNonEmptyString(value, 'query')
  if ([...query].length > MEMORY_QUERY_MAX_CHARS) {
    throw new BadRequestError(`query must be ${MEMORY_QUERY_MAX_CHARS} characters or fewer`)
  }
  return query
}

const parseLimit = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestError('limit must be a non-negative integer')
  }
  return Math.min(value, MEMORY_SEARCH_MAX_LIMIT)
}

const parseKind = (value: unknown): MemoryKind => {
  if (value === undefined) return 'fact'
  if (!isMemoryKind(value)) {
    throw new BadRequestError(`kind must be one of: ${MEMORY_KINDS.join(', ')}`)
  }
  return value
}

const parseScope = (value: unknown): MemoryScope => {
  if (value === undefined) return 'workspace'
  if (!isMemoryScope(value)) {
    throw new BadRequestError(`scope must be one of: ${MEMORY_SCOPES.join(', ')}`)
  }
  return value
}

const parseSearchScopes = (value: unknown): MemoryScope[] => {
  if (value === undefined) return ['workspace']
  if (value === 'all') return ['workspace', 'user']
  if (isMemoryScope(value)) return [value]
  throw new BadRequestError(`scope must be workspace, user, or all`)
}

const parseProcedureRef = (value: unknown): MemoryProcedureRef | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('procedure_ref must be an object')
  }
  const record = value as Record<string, unknown>
  if (!isMemoryProcedureRefType(record.type)) {
    throw new BadRequestError(
      `procedure_ref.type must be one of: ${MEMORY_PROCEDURE_REF_TYPES.join(', ')}`
    )
  }
  if (typeof record.id !== 'string' || !record.id.trim()) {
    throw new BadRequestError('procedure_ref.id must be a non-empty string')
  }
  const id = record.id.trim()
  if ([...id].length > MEMORY_PROCEDURE_REF_ID_MAX_CHARS) {
    throw new BadRequestError(
      `procedure_ref.id must be ${MEMORY_PROCEDURE_REF_ID_MAX_CHARS} characters or fewer`
    )
  }
  if (record.title !== undefined && record.title !== null && typeof record.title !== 'string') {
    throw new BadRequestError('procedure_ref.title must be a string')
  }
  const title = typeof record.title === 'string' ? record.title.trim() || null : null
  if (title !== null && [...title].length > MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS) {
    throw new BadRequestError(
      `procedure_ref.title must be ${MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS} characters or fewer`
    )
  }
  return { id, title, type: record.type }
}

const parseTags = (value: unknown) => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new BadRequestError('tags must be an array of strings')
  }
  if (value.length > MEMORY_TAG_MAX_COUNT) {
    throw new BadRequestError(`tags must contain ${MEMORY_TAG_MAX_COUNT} items or fewer`)
  }

  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new BadRequestError('tags must be non-empty strings')
    }
    const tag = item.trim()
    if ([...tag].length > MEMORY_TAG_MAX_CHARS) {
      throw new BadRequestError(`tags must be ${MEMORY_TAG_MAX_CHARS} characters or fewer`)
    }
    if (!tags.includes(tag)) tags.push(tag)
  }
  return tags
}

const authenticateMemoryRequest = (body: TeamMemoryAuthBody, store: RuntimeStore) => {
  const workspaceId = requireNonEmptyString(body.project_id, 'project_id')
  const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
  const token = typeof body.token === 'string' ? body.token : undefined
  const agent = authenticateCliAgent({
    fromAgentId,
    getAgent: store.getAgent,
    token,
    validateToken: store.validateAgentToken,
    workspaceId,
  })
  return { agent, workspaceId }
}

export const teamMemoryRoutes: RouteDefinition[] = [
  route('POST', '/api/team/memory/add', async ({ request, response, store }) => {
    const body = await readJsonBody<TeamMemoryAddBody>(request)
    const { agent, workspaceId } = authenticateMemoryRequest(body, store)
    requireCommandForRole(agent, 'memory_add')
    const kind = parseKind(body.kind)
    const procedureRef = parseProcedureRef(body.procedure_ref)
    if (kind === 'procedure_ref' && procedureRef === null) {
      throw new BadRequestError('procedure_ref is required when kind is procedure_ref')
    }

    const memory = store.addMemoryEntry({
      actor: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
      },
      body: requireMemoryBody(body.body),
      kind,
      ...(body.supersedes_id !== undefined
        ? { supersedesId: requireNonEmptyString(body.supersedes_id, 'supersedes_id') }
        : {}),
      procedureRef,
      scope: parseScope(body.scope),
      tags: parseTags(body.tags),
      workspaceId,
    })

    sendJson(response, 200, {
      memory: serializeMemoryEntry(memory),
      ok: true,
    })
  }),

  route('POST', '/api/team/memory/show', async ({ request, response, store }) => {
    const body = await readJsonBody<TeamMemoryShowBody>(request)
    const { agent, workspaceId } = authenticateMemoryRequest(body, store)
    requireCommandForRole(agent, 'memory_show')

    const memoryId = requireNonEmptyString(body.memory_id, 'memory_id')
    const memory = store.getMemoryEntry(workspaceId, memoryId)
    if (!memory) {
      sendJson(response, 404, { error: `Memory entry not found: ${memoryId}` })
      return
    }

    sendJson(response, 200, {
      memory: serializeMemoryEntry(memory),
      ok: true,
    })
  }),

  route('POST', '/api/team/memory/search', async ({ request, response, store }) => {
    const body = await readJsonBody<TeamMemorySearchBody>(request)
    const { agent, workspaceId } = authenticateMemoryRequest(body, store)
    requireCommandForRole(agent, 'memory_search')
    const limit = parseLimit(body.limit)

    const results = store.searchMemoryEntries(workspaceId, requireMemoryQuery(body.query), {
      ...(limit !== undefined ? { limit } : {}),
      scopes: parseSearchScopes(body.scope),
    })

    sendJson(response, 200, {
      ok: true,
      results: results.map(serializeMemorySearchResult),
    })
  }),

  route('POST', '/api/team/memory/dream/show', async ({ request, response, store }) => {
    const body = await readJsonBody<TeamMemoryDreamShowBody>(request)
    const { agent, workspaceId } = authenticateMemoryRequest(body, store)
    requireCommandForRole(agent, 'memory_dream_show')

    const runId = requireNonEmptyString(body.run_id, 'run_id')
    try {
      const input = store.getMemoryDreamInput(workspaceId, runId)
      sendJson(response, 200, {
        ok: true,
        prompt: input.prompt,
        run: serializeDreamRun(input.run),
      })
    } catch (error) {
      if (error instanceof DreamRunNotFoundError) {
        sendJson(response, 404, { error: `Dream run not found: ${error.runId}` })
        return
      }
      if (error instanceof DreamRunValidationError) {
        sendJson(response, 409, { error: error.message })
        return
      }
      throw error
    }
  }),

  route('POST', '/api/team/memory/apply', async ({ request, response, store }) => {
    const body = await readJsonBody<TeamMemoryApplyBody>(request)
    const { agent, workspaceId } = authenticateMemoryRequest(body, store)
    requireCommandForRole(agent, 'memory_apply')

    const runId = requireNonEmptyString(body.run_id, 'run_id')
    if (body.ops === undefined) throw new BadRequestError('Missing ops')
    try {
      sendJson(response, 200, {
        ok: true,
        run: serializeDreamRun(store.applyMemoryDreamRun(workspaceId, runId, body.ops)),
      })
    } catch (error) {
      if (error instanceof DreamRunNotFoundError) {
        sendJson(response, 404, { error: `Dream run not found: ${error.runId}` })
        return
      }
      if (error instanceof DreamRunValidationError) {
        sendJson(response, 409, { error: error.message })
        return
      }
      throw error
    }
  }),

  route('POST', '/api/team/memory/forget', async ({ request, response, store }) => {
    const body = await readJsonBody<TeamMemoryForgetBody>(request)
    const { agent, workspaceId } = authenticateMemoryRequest(body, store)
    requireCommandForRole(agent, 'memory_forget')

    const memoryId = requireNonEmptyString(body.memory_id, 'memory_id')
    const memory = store.getMemoryEntry(workspaceId, memoryId)
    if (!memory) {
      sendJson(response, 404, { error: `Memory entry not found: ${memoryId}` })
      return
    }

    try {
      sendJson(response, 200, {
        memory: serializeMemoryEntry(store.archiveMemoryEntry(workspaceId, memoryId)),
        ok: true,
      })
    } catch (error) {
      if (error instanceof MemoryEntryStatusError) {
        sendJson(response, 409, {
          error: `Memory entry has status ${error.actualStatus}; expected active`,
        })
        return
      }
      throw error
    }
  }),
]
