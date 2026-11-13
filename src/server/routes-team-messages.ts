import type { DispatchMessageKind } from '../shared/team-collaboration.js'
import {
  serializeDispatchMessage,
  serializeDispatchMessagesResult,
} from './dispatch-message-serializer.js'
import { BadRequestError, ConflictError } from './http-errors.js'
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
  route('POST', '/api/team/question', async ({ request, response, store }) => {
    const { body, workspaceId, agent } = await readMessageRequest(request, store, 'messages', [
      'question_id',
      'wait_ms',
    ])
    const waitMs = body.wait_ms === undefined ? 0 : body.wait_ms
    if (typeof waitMs !== 'number' || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000)
      throw new BadRequestError('wait_ms must be an integer from 0 to 60000')
    const questionId = requiredString(body.question_id, 'question_id')
    const read = () => store.getDispatchQuestion(workspaceId, agent.id, questionId)
    let result = read()
    if (result.status === 'pending' && waitMs > 0 && !store.isDispatchQuestionClosing()) {
      let readError: unknown
      await new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          unsubscribe()
          response.off('close', finish)
          resolve()
        }
        const check = () => {
          if (store.isDispatchQuestionClosing()) return finish()
          try {
            result = read()
            if (result.status !== 'pending') finish()
          } catch (error) {
            readError = error
            finish()
          }
        }
        const unsubscribe = store.subscribeDispatchQuestionChanges(workspaceId, check)
        const timer = setTimeout(finish, waitMs)
        response.once('close', finish)
        if (response.destroyed) finish()
        else check()
      })
      if (response.destroyed) return
      if (readError) throw readError
      if (!store.isDispatchQuestionClosing()) result = read()
    }
    sendJson(response, 200, {
      status: result.status,
      question: serializeDispatchMessage(result.question),
      answers: result.answers.map(serializeDispatchMessage),
    })
  }),
  route('POST', '/api/team/ask', async ({ request, response, store }) => {
    const { body, workspaceId, agent } = await readMessageRequest(request, store, 'message', [
      'dispatch_id',
      'text',
      'recipient',
    ])
    if (body.recipient !== undefined && body.recipient !== 'orchestrator')
      throw new BadRequestError('recipient must be orchestrator')
    if (agent.role === 'orchestrator' && body.recipient === 'orchestrator')
      throw new BadRequestError('The orchestrator cannot ask itself')
    let dispatchId = optionalString(body.dispatch_id, 'dispatch_id')
    if (!dispatchId && agent.role === 'orchestrator')
      throw new BadRequestError('dispatch_id is required for the orchestrator')
    if (!dispatchId) {
      const owned = store
        .listOpenDispatches(workspaceId)
        .filter((item) => item.toAgentId === agent.id)
      if (owned.length !== 1)
        throw new ConflictError('Specify dispatch_id when you do not own exactly one open dispatch')
      dispatchId = owned[0]?.id
    }
    if (!dispatchId) throw new ConflictError('No open dispatch')
    const message = store.sendDispatchMessage(workspaceId, agent.id, {
      dispatchId,
      kind: 'question',
      ...(agent.role === 'orchestrator' ? {} : { recipient: 'orchestrator' as const }),
      text: requiredString(body.text, 'text'),
    })
    sendJson(response, 202, { ok: true, message: serializeDispatchMessage(message) })
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
