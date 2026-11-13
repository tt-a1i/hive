import { RECALL_QUERY_MAX_CHARS } from '../shared/team-recall.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import type { RecallContextMessage, RecallResult } from './team-recall-store.js'

interface TeamRecallBody {
  from_agent_id?: unknown
  limit?: unknown
  project_id?: unknown
  query?: unknown
  token?: unknown
  window?: unknown
}

const requireNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  const trimmed = value.trim()
  if (field === 'query' && [...trimmed].length > RECALL_QUERY_MAX_CHARS) {
    throw new BadRequestError(`query must be ${RECALL_QUERY_MAX_CHARS} characters or fewer`)
  }
  return trimmed
}

const optionalNonNegativeInteger = (value: unknown, field: string) => {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new BadRequestError(`${field} must be a non-negative integer`)
  }
  return Number(value)
}

const serializeContext = (item: RecallContextMessage) => ({
  created_at: item.createdAt,
  from_agent_id: item.fromAgentId,
  source_sequence: item.sourceSequence,
  text: item.text,
  to_agent_id: item.toAgentId,
  type: item.type,
  worker_id: item.workerId,
})

const serializeRecallResult = (result: RecallResult) => ({
  context: result.context.map(serializeContext),
  created_at: result.createdAt,
  dispatch_id: result.dispatchId,
  dispatch_status: result.dispatchStatus,
  from_agent_id: result.fromAgentId,
  index_name: result.indexName,
  message_type: result.messageType,
  report_text: result.reportText,
  score: result.score,
  source_sequence: result.sourceSequence,
  source_type: result.sourceType,
  text: result.text,
  to_agent_id: result.toAgentId,
  worker_id: result.workerId,
})

export const teamRecallRoutes: RouteDefinition[] = [
  route('POST', '/api/team/recall', async ({ request, response, store }) => {
    const body = await readJsonBody<TeamRecallBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const query = requireNonEmptyString(body.query, 'query')
    const token = typeof body.token === 'string' ? body.token : undefined
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'recall')

    const limit = optionalNonNegativeInteger(body.limit, 'limit')
    const window = optionalNonNegativeInteger(body.window, 'window')
    const recallResults = store.recallMessages(projectId, query, {
      ...(limit !== undefined ? { limit } : {}),
      ...(window !== undefined ? { window } : {}),
    })
    sendJson(response, 200, {
      ok: true,
      query,
      results: recallResults.map(serializeRecallResult),
    })
  }),
]
