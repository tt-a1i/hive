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
  status: string | undefined,
  artifacts: string[]
): MessageLogRecord => {
  const message: MessageLogRecord = {
    artifacts,
    createdAt: Date.now(),
    fromAgentId: workerId,
    text,
    type: 'report',
    workerId,
    workspaceId,
  }
  if (status) message.status = status
  return message
}

export const createStatusMessage = (
  workspaceId: string,
  workerId: string,
  text: string,
  artifacts: string[]
): MessageLogRecord => ({
  artifacts,
  createdAt: Date.now(),
  fromAgentId: workerId,
  text,
  type: 'status',
  workerId,
  workspaceId,
})

export const createSystemEnvSyncMessage = (
  workspaceId: string,
  agentId: string,
  text: string
): MessageLogRecord => ({
  createdAt: Date.now(),
  text,
  toAgentId: agentId,
  type: 'system_env_sync',
  workerId: agentId,
  workspaceId,
})

export const createSystemRecoverySummaryMessage = (
  workspaceId: string,
  agentId: string,
  text: string
): MessageLogRecord => ({
  createdAt: Date.now(),
  text,
  toAgentId: agentId,
  type: 'system_recovery_summary',
  workerId: agentId,
  workspaceId,
})
