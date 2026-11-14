import type { DispatchMessageRecord } from '../shared/team-collaboration.js'
import type { AgentRunStorePort } from './agent-runtime-ports.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { FeatureFlags } from './feature-flags.js'
import type { MessageLogHandle, MessageLogRecord, RecoveryMessage } from './message-log-store.js'
import { createRestartPolicy } from './restart-policy.js'
import type { TasksFileService } from './tasks-file.js'
import type { WorkspaceStore } from './workspace-store.js'

// Narrow helper keeps runtime-store under the hard line cap.
export const buildRuntimeRestartPolicy = ({
  agentRunStore,
  messageLogStore,
  settings,
  listAllDispatches,
  listOpenDispatches,
  listDispatchMessagesForRecovery,
  listActionableDispatchMessagesForRecovery,
  tasksFileService,
  workspaceStore,
  getFlags,
}: {
  agentRunStore: Pick<AgentRunStorePort, 'listAgentRuns'>
  settings: {
    getAppState: (key: string) => { value: string | null } | undefined
    setAppState: (key: string, value: string | null) => void
  }
  listAllDispatches: (workspaceId: string) => DispatchRecord[]
  listActionableDispatchMessagesForRecovery?: (
    workspaceId: string,
    agentId: string
  ) => DispatchMessageRecord[]
  listDispatchMessagesForRecovery?: (workspaceId: string) => DispatchMessageRecord[]
  listOpenDispatches?: (workspaceId: string) => DispatchRecord[]
  messageLogStore: {
    deleteMessage: (handle: MessageLogHandle) => void
    insertMessage: (record: MessageLogRecord) => MessageLogHandle
    listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  }
  tasksFileService: Pick<TasksFileService, 'readTasks'>
  workspaceStore: Pick<WorkspaceStore, 'getWorkspaceSnapshot'>
  getFlags?: () => FeatureFlags
}) =>
  createRestartPolicy({
    deleteMessage: messageLogStore.deleteMessage,
    getWorkspaceSnapshot: workspaceStore.getWorkspaceSnapshot,
    getHandover: (workspaceId, agentId) =>
      settings.getAppState(`agent_handover:${workspaceId}:${agentId}`)?.value ?? undefined,
    completeHandover: (workspaceId, agentId, token) => {
      const key = `agent_handover:${workspaceId}:${agentId}`
      if (settings.getAppState(key)?.value === token) settings.setAppState(key, null)
    },
    listAllDispatches,
    insertMessage: messageLogStore.insertMessage,
    listAgentRuns: agentRunStore.listAgentRuns,
    listMessagesForRecovery: messageLogStore.listMessagesForRecovery,
    ...(listOpenDispatches ? { listOpenDispatches } : {}),
    ...(listDispatchMessagesForRecovery ? { listDispatchMessagesForRecovery } : {}),
    ...(listActionableDispatchMessagesForRecovery
      ? { listActionableDispatchMessagesForRecovery }
      : {}),
    readTasks: tasksFileService.readTasks,
    ...(getFlags ? { getFlags } : {}),
  })
