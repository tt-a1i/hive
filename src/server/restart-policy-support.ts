import type { DispatchMessageRecord } from '../shared/team-collaboration.js'
import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { PersistedAgentRun } from './agent-run-store.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { FeatureFlags } from './feature-flags.js'
import type { MessageLogHandle, MessageLogRecord, RecoveryMessage } from './message-log-store.js'

export interface RestartPolicyInput {
  deleteMessage: (handle: MessageLogHandle) => void
  getWorkspaceSnapshot: (workspaceId: string) => {
    agents: AgentSummary[]
    summary: WorkspaceSummary
  }
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listActionableDispatchMessagesForRecovery?: (
    workspaceId: string,
    agentId: string
  ) => DispatchMessageRecord[]
  listDispatchMessagesForRecovery?: (workspaceId: string) => DispatchMessageRecord[]
  listOpenDispatches?: (workspaceId: string) => DispatchRecord[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  readTasks: (workspacePath: string) => string
  /** Resolves the live experimental flags, threaded into the recovery handover
   *  prompt so it matches a fresh startup. Optional; omitted → all off. */
  getFlags?: () => FeatureFlags
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
  writeToRun: (runId: string, text: string) => Promise<void>
}) => {
  const handle = insertMessage(record)
  try {
    void writeToRun(runId, text).catch(() => {
      try {
        deleteMessage(handle)
      } catch {
        // The runtime may already be closing; the failed post-start write is
        // non-critical once the run is gone.
      }
    })
  } catch (error) {
    deleteMessage(handle)
    throw error
  }
}
