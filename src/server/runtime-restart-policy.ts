import type { AgentRunStorePort } from './agent-runtime-ports.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import type { DiscussionGroup, DiscussionOperations } from './discussion-operations.js'
import type { MessageLogHandle, MessageLogRecord, RecoveryMessage } from './message-log-store.js'
import type { ActiveDiscussionInfo, ActiveDispatchInfo } from './recovery-summary.js'
import { createRestartPolicy } from './restart-policy.js'
import type { TasksFileService } from './tasks-file.js'
import type { WorkspaceStore } from './workspace-store.js'

const toDispatchInfo = (
  dispatch: DispatchRecord,
  getWorkerName: (agentId: string) => string
): ActiveDispatchInfo => ({
  status: dispatch.status,
  text: dispatch.text,
  toWorkerName: getWorkerName(dispatch.toAgentId),
})

const toDiscussionInfo = (group: DiscussionGroup): ActiveDiscussionInfo => ({
  currentRound: group.current_round,
  maxRounds: group.max_rounds,
  status: group.status,
  topic: group.topic,
})

export const buildRuntimeRestartPolicy = ({
  agentRunStore,
  discussionOps,
  dispatchLedgerStore,
  messageLogStore,
  tasksFileService,
  workspaceStore,
}: {
  agentRunStore: Pick<AgentRunStorePort, 'listAgentRuns'> & { getCheckpoint: (agentId: string) => string | null }
  discussionOps: Pick<DiscussionOperations, 'getActiveGroupsForWorkspace'>
  dispatchLedgerStore: { listWorkspaceDispatches: (workspaceId: string, options?: ListDispatchesOptions) => DispatchRecord[] }
  messageLogStore: {
    deleteMessage: (handle: MessageLogHandle) => void
    insertMessage: (record: MessageLogRecord) => MessageLogHandle
    listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  }
  tasksFileService: Pick<TasksFileService, 'readTasks'>
  workspaceStore: Pick<WorkspaceStore, 'getWorkspaceSnapshot'>
}) =>
  createRestartPolicy({
    deleteMessage: messageLogStore.deleteMessage,
    getCheckpoint: agentRunStore.getCheckpoint,
    getWorkspaceSnapshot: workspaceStore.getWorkspaceSnapshot,
    insertMessage: messageLogStore.insertMessage,
    listActiveDispatches: (workspaceId) => {
      const snapshot = workspaceStore.getWorkspaceSnapshot(workspaceId)
      const nameMap = new Map(snapshot.agents.map((a) => [a.id, a.name]))
      const dispatches = dispatchLedgerStore.listWorkspaceDispatches(workspaceId, { status: 'submitted' })
      const queued = dispatchLedgerStore.listWorkspaceDispatches(workspaceId, { status: 'queued' })
      return [...dispatches, ...queued].slice(0, 10).map((d) =>
        toDispatchInfo(d, (id) => nameMap.get(id) ?? id)
      )
    },
    listActiveDiscussions: (workspaceId) => {
      const groups = discussionOps.getActiveGroupsForWorkspace(workspaceId)
      return groups.map(toDiscussionInfo)
    },
    listAgentRuns: agentRunStore.listAgentRuns,
    listMessagesForRecovery: messageLogStore.listMessagesForRecovery,
    readTasks: tasksFileService.readTasks,
  })
