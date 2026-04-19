import type { MessageLogRecord } from './message-log-store.js'

export const createUserInputMessage = (
  workspaceId: string,
  orchestratorId: string,
  text: string
): MessageLogRecord => ({
  createdAt: Date.now(),
  text,
  type: 'user_input',
  workerId: orchestratorId,
  workspaceId,
})

export const createSendMessage = (
  workspaceId: string,
  workerId: string,
  text: string,
  fromAgentId?: string
): MessageLogRecord => {
  const message: MessageLogRecord = {
    createdAt: Date.now(),
    text,
    toAgentId: workerId,
    type: 'send',
    workerId,
    workspaceId,
  }

  if (fromAgentId) {
    message.fromAgentId = fromAgentId
  }

  return message
}

export const createReportMessage = (
  workspaceId: string,
  workerId: string,
  text: string,
  status: string,
  artifacts: string[]
): MessageLogRecord => ({
  artifacts,
  createdAt: Date.now(),
  fromAgentId: workerId,
  status,
  text,
  type: 'report',
  workerId,
  workspaceId,
})
