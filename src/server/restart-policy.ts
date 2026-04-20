import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { buildEnvSyncMessage } from './env-sync-message.js'
import { buildRecoverySummary } from './recovery-summary.js'
import {
  findPreviousRun,
  type RestartPolicyInput,
  writeSystemMessage,
} from './restart-policy-support.js'
import {
  createSystemEnvSyncMessage,
  createSystemRecoverySummaryMessage,
} from './runtime-message-builders.js'

const RECOVERY_WINDOW_MS = 60 * 60 * 1000

export interface RestartPolicy {
  injectPostStartMessage: (input: {
    agentId: string
    runId: string
    startConfig: AgentLaunchConfigInput
    workspace: WorkspaceSummary
    writeToRun: (runId: string, text: string) => void
  }) => void
}

export const createNoopRestartPolicy = (): RestartPolicy => ({
  injectPostStartMessage() {},
})

export const createRestartPolicy = ({
  deleteMessage,
  getWorkspaceSnapshot,
  insertMessage,
  listAgentRuns,
  listMessagesForRecovery,
  readTasks,
}: RestartPolicyInput): RestartPolicy => ({
  injectPostStartMessage({ agentId, runId, startConfig, workspace, writeToRun }) {
    const previousRun = findPreviousRun(listAgentRuns(agentId), runId)
    if (!previousRun) return

    const snapshot = getWorkspaceSnapshot(workspace.id)
    const agent = snapshot.agents.find((item) => item.id === agentId)
    if (!agent) return
    const workers = snapshot.agents.filter(
      (item) => item.role !== 'orchestrator' && item.id !== agentId
    )
    const tasksContent = readTasks(snapshot.summary.path)

    if (startConfig.resumedSessionId) {
      const sinceMs = previousRun.endedAt ?? previousRun.startedAt
      const text = buildEnvSyncMessage({
        tasksContent,
        workers,
        workspace,
        restartWindowMessages: listMessagesForRecovery(workspace.id, sinceMs),
      })
      writeSystemMessage({
        deleteMessage,
        insertMessage,
        record: createSystemEnvSyncMessage(workspace.id, agentId, text),
        runId,
        text,
        writeToRun,
      })
      return
    }

    const text = buildRecoverySummary({
      agent,
      messages: listMessagesForRecovery(workspace.id, Date.now() - RECOVERY_WINDOW_MS),
      tasksContent,
      workers,
      workspace,
    })
    writeSystemMessage({
      deleteMessage,
      insertMessage,
      record: createSystemRecoverySummaryMessage(workspace.id, agentId, text),
      runId,
      text,
      writeToRun,
    })
  },
})
