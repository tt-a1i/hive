import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { FEATURE_FLAGS_ALL_OFF } from './feature-flags.js'
import { isResumeLaunchConfig } from './preset-launch-support.js'
import { buildRecoverySummary } from './recovery-summary.js'
import {
  findPreviousRun,
  type RestartPolicyInput,
  writeSystemMessage,
} from './restart-policy-support.js'
import { createSystemRecoverySummaryMessage } from './runtime-message-builders.js'
import {
  buildMemoryDigestSafely,
  logMemoryDigestInjection,
  rollbackMemoryDigestInjection,
} from './team-memory-injection.js'

const RECOVERY_WINDOW_MS = 60 * 60 * 1000

export interface RestartPolicy {
  injectPostStartMessage: (input: {
    agentId: string
    runId: string
    startConfig: AgentLaunchConfigInput
    workspace: WorkspaceSummary
    writeToRun: (runId: string, text: string) => Promise<void>
  }) => boolean
  /** Record that `runId` was killed at the user's request (Stop button), so a
   *  subsequent restart does not inject the crash-recovery handover for a run
   *  the user deliberately ended. */
  markUserStopped: (runId: string) => void
}

export const createNoopRestartPolicy = (): RestartPolicy => ({
  injectPostStartMessage() {
    return false
  },
  markUserStopped() {},
})

export const createRestartPolicy = ({
  deleteMessage,
  getWorkspaceSnapshot,
  insertMessage,
  listAgentRuns,
  listMessagesForRecovery,
  listOpenDispatches,
  listDispatchMessagesForRecovery,
  listActionableDispatchMessagesForRecovery,
  memoryInjection,
  readTasks,
  getFlags,
}: RestartPolicyInput): RestartPolicy => {
  // Runs the user killed via the Stop button. A deliberate stop is otherwise
  // byte-identical to a crash (both end status 'error'), so without this a
  // stop+Restart would inject the "could not recover" handover with stale open
  // tasks the user may have meant to abandon. In-process only: after a runtime
  // restart this is empty, which is correct — that case IS a recovery.
  const userStoppedRuns = new Set<string>()
  return {
    markUserStopped(runId: string) {
      userStoppedRuns.add(runId)
    },
    injectPostStartMessage({ agentId, runId, startConfig, workspace, writeToRun }) {
      const previousRun = findPreviousRun(listAgentRuns(agentId), runId)
      if (!previousRun) return false
      // Consume the marker whether or not we end up skipping, so it never
      // lingers to suppress a later genuine crash on the same run id.
      const wasUserStopped = userStoppedRuns.delete(previousRun.runId)

      const snapshot = getWorkspaceSnapshot(workspace.id)
      const agent = snapshot.agents.find((item) => item.id === agentId)
      if (!agent) return false
      const workers = snapshot.agents.filter(
        (item) => item.role !== 'orchestrator' && item.id !== agentId
      )
      const tasksContent = readTasks(snapshot.summary.path)

      const openDispatches = listOpenDispatches?.(workspace.id)
      const actionableDispatchMessages =
        listActionableDispatchMessagesForRecovery?.(workspace.id, agentId) ?? []
      const ownsOpenWork = openDispatches?.some(
        (dispatch) => agent.role === 'orchestrator' || dispatch.toAgentId === agentId
      )
      // Stopping a process does not cancel a responsibility or retire a question.
      // A deliberate restart without outstanding protocol work can start fresh.
      if (wasUserStopped && !ownsOpenWork && actionableDispatchMessages.length === 0) return false

      const memoryDigest = buildMemoryDigestSafely({
        contextType: 'recovery',
        memoryInjection,
        workspaceId: workspace.id,
      })
      const injectionIds = logMemoryDigestInjection({
        agentId,
        contextType: 'recovery',
        memoryDigest,
        memoryInjection,
        workspaceId: workspace.id,
      })
      const auditedMemoryDigest = injectionIds ? memoryDigest : null
      const text = buildRecoverySummary({
        agent,
        resumedSession: isResumeLaunchConfig(startConfig),
        dispatchMessages: listDispatchMessagesForRecovery?.(workspace.id) ?? [],
        actionableDispatchMessages,
        ...(openDispatches ? { openDispatches } : {}),
        memoryDigest: auditedMemoryDigest?.text,
        messages: listMessagesForRecovery(workspace.id, Date.now() - RECOVERY_WINDOW_MS),
        tasksContent,
        workers,
        workspace,
        flags: getFlags?.() ?? FEATURE_FLAGS_ALL_OFF,
      })
      writeSystemMessage({
        deleteMessage,
        insertMessage,
        record: createSystemRecoverySummaryMessage(workspace.id, agentId, text),
        runId,
        text,
        writeToRun,
        onWriteFailure: () => rollbackMemoryDigestInjection({ injectionIds, memoryInjection }),
      })
      return true
    },
  }
}
