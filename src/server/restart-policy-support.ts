import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { PersistedAgentRun } from './agent-run-store.js'
import type { MessageLogHandle, MessageLogRecord, RecoveryMessage } from './message-log-store.js'

export interface RestartPolicyInput {
  deleteMessage: (handle: MessageLogHandle) => void
  getWorkspaceSnapshot: (workspaceId: string) => {
    agents: AgentSummary[]
    summary: WorkspaceSummary
  }
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  readTasks: (workspacePath: string) => string
}

export const findPreviousRun = (runs: PersistedAgentRun[], currentRunId: string) =>
  runs.find((run) => run.runId !== currentRunId)

export const writeSystemMessage = ({
  deleteMessage,
  insertMessage,
  record,
  runId,
  text,
  writeToRun,
}: {
  deleteMessage: RestartPolicyInput['deleteMessage']
  insertMessage: RestartPolicyInput['insertMessage']
  record: MessageLogRecord
  runId: string
  text: string
  writeToRun: (runId: string, text: string) => void
}) => {
  const handle = insertMessage(record)
  try {
    writeToRun(runId, `${text}\n`)
  } catch (error) {
    deleteMessage(handle)
    throw error
  }
}
