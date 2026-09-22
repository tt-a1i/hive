import type { SendDispatchMessageInput } from '../shared/team-collaboration.js'
import type { AgentSummary } from '../shared/types.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { DispatchMessageStore } from './dispatch-message-store.js'
import { BadRequestError, ConflictError, ForbiddenError } from './http-errors.js'

export const isDispatchOpen = (dispatch: DispatchRecord) =>
  dispatch.status === 'queued' || dispatch.status === 'submitted'
export const dispatchRoot = (dispatch: DispatchRecord) => dispatch.rootDispatchId ?? dispatch.id
export interface DispatchMessagePolicyPorts {
  hasAgent: (workspaceId: string, id: string) => boolean
  getDispatch: (workspaceId: string, id: string) => DispatchRecord | undefined
  getAgent: (workspaceId: string, id: string) => AgentSummary
  messages: DispatchMessageStore
}

export const authorizeDispatchMessage = (
  ports: DispatchMessagePolicyPorts,
  workspaceId: string,
  fromAgentId: string,
  input: SendDispatchMessageInput
) => {
  const actor = ports.getAgent(workspaceId, fromAgentId)
  const target = ports.getDispatch(workspaceId, input.dispatchId)
  if (!target) throw new ConflictError('Dispatch does not exist in this workspace')
  if (!['note', 'question', 'answer', 'progress'].includes(input.kind))
    throw new BadRequestError('Invalid message kind')
  if (!input.text.trim()) throw new BadRequestError('Message text must not be empty')
  if (input.recipient && !['owner', 'orchestrator'].includes(input.recipient))
    throw new BadRequestError('Invalid recipient')
  const recipientAgentId =
    input.recipient === 'orchestrator' ? `${workspaceId}:orchestrator` : target.toAgentId
  const binding = ports.messages.controllerBinding(workspaceId)
  if (
    binding.external &&
    !binding.threadId &&
    (fromAgentId === `${workspaceId}:orchestrator` ||
      (recipientAgentId === `${workspaceId}:orchestrator` && input.kind !== 'progress'))
  ) {
    throw new ConflictError(
      'No Codex App controller is connected. Connect and confirm a controller before sending task messages. Do not create or close another responsibility to bypass this.'
    )
  }
  if (input.kind === 'progress' && input.recipient !== 'orchestrator')
    throw new BadRequestError('Progress is recorded for the orchestrator; use --to orchestrator')
  const sourceId =
    input.sourceDispatchId ??
    (actor.role !== 'orchestrator' && target.toAgentId === fromAgentId ? target.id : undefined)
  const source = sourceId ? ports.getDispatch(workspaceId, sourceId) : undefined
  if (actor.role !== 'orchestrator') {
    if (!source || source.toAgentId !== fromAgentId)
      throw new ForbiddenError('Provide a source dispatch you own')
    if (
      dispatchRoot(source) !== dispatchRoot(target) &&
      input.kind !== 'question' &&
      input.kind !== 'answer'
    )
      throw new ForbiddenError('Dispatches must belong to the same collaboration')
    if (input.recipient === 'orchestrator' && source.id !== target.id)
      throw new ForbiddenError('Address the orchestrator using your own dispatch')
  } else if (sourceId) {
    throw new BadRequestError('The orchestrator must not claim a worker source dispatch')
  }
  if (target.status === 'cancelled' || source?.status === 'cancelled')
    throw new ConflictError('Cancelled responsibilities cannot exchange messages')
  const reply = input.replyTo ? ports.messages.getMessage(workspaceId, input.replyTo) : undefined
  if (input.kind === 'answer') {
    if (!reply || reply.kind !== 'question' || reply.recipientAgentId !== fromAgentId)
      throw new ForbiddenError('Answer must reference a question addressed to you')
    if (reply.deliveryState === 'cancelled')
      throw new ConflictError(
        'This question was retired. Ask the current controller for a new question; do not answer or reopen the retired one.'
      )
    const questionThread = ports.messages.messageControllerThread(workspaceId, reply.id)
    if (questionThread && questionThread !== binding.threadId) {
      throw new ConflictError(
        'The controller that asked this question is no longer connected. Do not reroute the answer; the current controller must ask a new question.'
      )
    }
    const replyTarget = ports.getDispatch(workspaceId, reply.dispatchId)
    if (!replyTarget) throw new ForbiddenError('Question responsibility no longer exists')
    if (reply.fromAgentId !== recipientAgentId)
      throw new ForbiddenError('Answer must return to the question sender')
    if (actor.role === 'orchestrator') {
      if (reply.dispatchId !== target.id)
        throw new ForbiddenError('Answer must return to the question responsibility')
    } else if (reply.fromAgentId === `${workspaceId}:orchestrator`) {
      if (source?.id !== reply.dispatchId || target.id !== reply.dispatchId)
        throw new ForbiddenError('Answer must use the original responsibility')
    } else if (source?.id !== reply.dispatchId || target.id !== reply.sourceDispatchId) {
      throw new ForbiddenError('Answer source and target must reverse the question')
    }
  } else if (input.replyTo) throw new BadRequestError('Only answers may reference reply_to')
  const historicalQuestion =
    input.kind === 'question' &&
    target.status === 'reported' &&
    (actor.role === 'orchestrator' || (source && isDispatchOpen(source)))
  const historicalAnswer =
    input.kind === 'answer' &&
    source?.status === 'reported' &&
    (isDispatchOpen(target) || (input.recipient === 'orchestrator' && source.id === target.id))
  if (
    !isDispatchOpen(target) &&
    !historicalQuestion &&
    !(historicalAnswer && input.recipient === 'orchestrator')
  )
    throw new ConflictError(
      'Dispatch is closed; ask the orchestrator to create a related responsibility for new work'
    )
  if (source && !isDispatchOpen(source) && !historicalAnswer)
    throw new ConflictError(
      'Source responsibility is closed; only an answer to its received question is allowed'
    )
  if (!ports.hasAgent(workspaceId, recipientAgentId))
    throw new ConflictError(
      'The message recipient was removed; ask the orchestrator for an available member'
    )
  return { target, source, recipientAgentId }
}
