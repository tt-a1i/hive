import type {
  DispatchMessageRecord,
  SendDispatchMessageInput,
} from '../shared/team-collaboration.js'

/** Formats a persisted question's reverse route; authorization is rechecked on send. */
export const getDispatchQuestionReplyInput = (
  message: DispatchMessageRecord,
  text: string
): SendDispatchMessageInput | null => {
  if (message.kind !== 'question') return null
  const orchestratorId = `${message.workspaceId}:orchestrator`
  const fromOrchestrator = message.fromAgentId === orchestratorId
  const toOrchestrator = message.recipientAgentId === orchestratorId
  const replyTarget =
    fromOrchestrator || toOrchestrator ? message.dispatchId : message.sourceDispatchId
  if (!replyTarget) return null
  return {
    dispatchId: replyTarget,
    ...(!fromOrchestrator && !toOrchestrator ? { sourceDispatchId: message.dispatchId } : {}),
    ...(fromOrchestrator ? { recipient: 'orchestrator' as const } : {}),
    kind: 'answer',
    replyTo: message.id,
    text,
  }
}

export const buildDispatchQuestionReplyCommand = (message: DispatchMessageRecord) => {
  if (!getDispatchQuestionReplyInput(message, '')) return null
  return `team reply ${message.id} --stdin`
}
