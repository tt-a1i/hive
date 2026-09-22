import type { DispatchMessageKind } from '../shared/team-collaboration.js'
import { DELEGATION_LIMITS } from './dispatch-delegation.js'
import {
  serializeDispatchMessage,
  serializeDispatchMessagesResult,
} from './dispatch-message-serializer.js'
import { BadRequestError, ForbiddenError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteContext, RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole, type TeamCommand } from './team-authz.js'

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`Missing ${field}`)
  return value
}
const optionalString = (value: unknown, field: string) =>
  value === undefined ? undefined : requiredString(value, field)
export const optionalSequence = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new BadRequestError(`${field} must be a non-negative safe integer`)
  return value
}

const rejectUnknownFields = (body: Record<string, unknown>, fields: string[]) => {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestError('Expected a JSON object')
  const allowed = new Set(['project_id', 'from_agent_id', 'token', ...fields])
  for (const field of Object.keys(body))
    if (!allowed.has(field)) throw new BadRequestError(`Unknown field: ${field}`)
}

const readMessageRequest = async (
  request: RouteContext['request'],
  store: RouteContext['store'],
  command: TeamCommand,
  fields: string[]
) => {
  const body = await readJsonBody<Record<string, unknown>>(request)
  rejectUnknownFields(body, fields)
  const workspaceId = requiredString(body.project_id, 'project_id')
  const agent = authenticateCliAgent({
    workspaceId,
    fromAgentId: requiredString(body.from_agent_id, 'from_agent_id'),
    token: optionalString(body.token, 'token'),
    getAgent: store.getAgent,
    validateToken: store.validateAgentToken,
  })
  requireCommandForRole(agent, command)
  return { body, workspaceId, agent }
}

export { serializeDispatchMessage } from './dispatch-message-serializer.js'

export const teamMessageRoutes: RouteDefinition[] = [
  route('POST', '/api/team/questions', async ({ request, response, store }) => {
    const { body, workspaceId, agent } = await readMessageRequest(request, store, 'messages', [
      'dispatch_id',
      'before_id',
    ])
    const result = store.listSentDispatchQuestions(
      workspaceId,
      agent.id,
      optionalString(body.dispatch_id, 'dispatch_id'),
      optionalString(body.before_id, 'before_id')
    )
    sendJson(response, 200, {
      questions: result.questions.map(serializeDispatchMessage),
      next_before: result.nextBefore,
    })
  }),
  route('POST', '/api/team/delegate', async ({ request, response, store }) => {
    const { body, workspaceId, agent } = await readMessageRequest(request, store, 'delegate', [
      'from_dispatch_id',
      'to',
      'text',
    ])
    const dispatch = await store.dispatchTaskByWorkerName(
      workspaceId,
      requiredString(body.to, 'to'),
      requiredString(body.text, 'text'),
      {
        fromAgentId: agent.id,
        delegatedFromId: requiredString(body.from_dispatch_id, 'from_dispatch_id'),
        autoStartWorker: false,
        hivePort: String(request.socket.localPort ?? ''),
      }
    )
    sendJson(response, 202, {
      ok: true,
      dispatch_id: dispatch.id,
      delegated_from_id: dispatch.delegatedFromId,
      root_dispatch_id: dispatch.rootDispatchId,
      state: dispatch.status,
      limits: DELEGATION_LIMITS,
      queued: dispatch.queuedForStoppedWorker === true,
    })
  }),
  route('POST', '/api/team/peers', async ({ request, response, store }) => {
    const { workspaceId } = await readMessageRequest(request, store, 'messages', [])
    sendJson(response, 200, { members: store.listCollaborationPeers(workspaceId) })
  }),
  route('POST', '/api/team/inbox', async ({ request, response, store }) => {
    const { body, workspaceId, agent } = await readMessageRequest(request, store, 'messages', [
      'ack_batch_id',
    ])
    if (
      agent.role === 'orchestrator' &&
      store.getWorkspaceSnapshot(workspaceId).summary.controller_mode === 'codex_app'
    )
      throw new ForbiddenError(
        'The external controller uses read_reports/ack_reports through its confirmed host binding'
      )
    if (body.ack_batch_id !== undefined) {
      const result = store.acknowledgeMailbox(
        workspaceId,
        agent.id,
        requiredString(body.ack_batch_id, 'ack_batch_id')
      )
      sendJson(response, 200, {
        batch_id: result.batchId,
        acknowledged_message_ids: result.acknowledgedMessageIds,
      })
      return
    }
    const result = store.readMailbox(workspaceId, agent.id)
    sendJson(response, 200, {
      batch_id: result.batchId,
      messages: result.messages.map(serializeDispatchMessage),
    })
  }),
  route('POST', '/api/team/question', async ({ request, response, store }) => {
    const { body, workspaceId, agent } = await readMessageRequest(request, store, 'messages', [
      'question_id',
    ])
    const result = store.getDispatchQuestion(
      workspaceId,
      agent.id,
      requiredString(body.question_id, 'question_id')
    )
    sendJson(response, 200, {
      status: result.status,
      question: serializeDispatchMessage(result.question),
      answers: result.answers.map(serializeDispatchMessage),
    })
  }),
  route('POST', '/api/team/reply', async ({ request, response, store }) => {
    const { body, workspaceId, agent } = await readMessageRequest(request, store, 'message', [
      'question_id',
      'text',
    ])
    const input = store.getDispatchReplyInput(
      workspaceId,
      agent.id,
      requiredString(body.question_id, 'question_id'),
      requiredString(body.text, 'text')
    )
    const message = store.sendDispatchMessage(workspaceId, agent.id, input)
    sendJson(response, 202, { ok: true, message: serializeDispatchMessage(message) })
  }),
  route('POST', '/api/team/message', async ({ request, response, store }) => {
    const { body, workspaceId, agent } = await readMessageRequest(request, store, 'message', [
      'dispatch_id',
      'source_dispatch_id',
      'recipient',
      'kind',
      'reply_to',
      'text',
    ])
    const kind = body.kind
    if (typeof kind !== 'string' || !['note', 'question', 'answer', 'progress'].includes(kind))
      throw new BadRequestError('kind must be note, question, answer, or progress')
    const recipient = body.recipient
    if (recipient !== undefined && recipient !== 'owner' && recipient !== 'orchestrator')
      throw new BadRequestError('recipient must be owner or orchestrator')
    const sourceDispatchId = optionalString(body.source_dispatch_id, 'source_dispatch_id')
    const replyTo = optionalString(body.reply_to, 'reply_to')
    if (kind === 'answer' && !replyTo) throw new BadRequestError('answer requires reply_to')
    const message = store.sendDispatchMessage(workspaceId, agent.id, {
      dispatchId: requiredString(body.dispatch_id, 'dispatch_id'),
      kind: kind as DispatchMessageKind,
      text: requiredString(body.text, 'text'),
      ...(sourceDispatchId !== undefined ? { sourceDispatchId } : {}),
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(recipient !== undefined ? { recipient } : {}),
    })
    sendJson(response, 202, { ok: true, message: serializeDispatchMessage(message) })
  }),
  route('POST', '/api/team/messages', async ({ request, response, store }) => {
    const { body, workspaceId, agent } = await readMessageRequest(request, store, 'messages', [
      'dispatch_id',
      'after_seq',
    ])
    const result = store.listDispatchMessages(
      workspaceId,
      agent.id,
      requiredString(body.dispatch_id, 'dispatch_id'),
      optionalSequence(body.after_seq, 'after_seq')
    )
    sendJson(response, 200, serializeDispatchMessagesResult(result))
  }),
]
