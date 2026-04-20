import type { AgentManager } from './agent-manager.js'
import { type AgentLaunchConfigInput, createAgentRunStore } from './agent-run-store.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentSessionStore } from './agent-session-store.js'
import { createMessageLogStore } from './message-log-store.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { openRuntimeDatabase } from './runtime-database.js'
import { buildRuntimeRestartPolicy } from './runtime-restart-policy.js'
import { createSettingsStore } from './settings-store.js'
import { createTasksFileService } from './tasks-file.js'
import { createTasksFileWatcher } from './tasks-file-watcher.js'
import { createTeamOperations } from './team-operations.js'
import { createUiAuth } from './ui-auth.js'
import { createWorkspaceStore } from './workspace-store.js'

export interface RuntimeStoreServices {
  agentRunStore: ReturnType<typeof createAgentRunStore>
  agentRuntime: ReturnType<typeof createAgentRuntime>
  db: ReturnType<typeof openRuntimeDatabase>
  messageLogStore: ReturnType<typeof createMessageLogStore>
  settings: ReturnType<typeof createSettingsStore>
  tasksFileWatcher: ReturnType<typeof createTasksFileWatcher>
  tasksFileWatchCallbacks: Set<(workspaceId: string, content: string) => void>
  tasksFileService: ReturnType<typeof createTasksFileService>
  teamOps: ReturnType<typeof createTeamOperations>
  uiAuth: ReturnType<typeof createUiAuth>
  workspaceStore: ReturnType<typeof createWorkspaceStore>
}

interface CreateRuntimeStoreServicesOptions {
  agentManager?: AgentManager
  dataDir?: string
}

interface CreateRuntimeStoreLifecycleOptions {
  agentManager?: AgentManager
  services: RuntimeStoreServices
}

const notifyTasksUpdated = (
  callbacks: Set<(workspaceId: string, content: string) => void>,
  workspaceId: string,
  content: string
) => {
  for (const callback of callbacks) {
    callback(workspaceId, content)
  }
}

export const createRuntimeStoreServices = (
  options: CreateRuntimeStoreServicesOptions = {}
): RuntimeStoreServices => {
  const db = openRuntimeDatabase(options.dataDir)
  const messageLogStore = createMessageLogStore(db)
  const agentRunStore = createAgentRunStore(db)
  const agentSessionStore = createAgentSessionStore(db)
  const settings = createSettingsStore(db)
  const tasksFileService = createTasksFileService()
  const tasksFileWatchCallbacks = new Set<(workspaceId: string, content: string) => void>()
  const tasksFileWatcher = createTasksFileWatcher({
    onTasksUpdated: (workspaceId, content) => {
      notifyTasksUpdated(tasksFileWatchCallbacks, workspaceId, content)
    },
  })
  const uiAuth = createUiAuth()

  messageLogStore.initialize()
  agentRunStore.initialize()

  const workspaceStore = createWorkspaceStore(db, messageLogStore.listMessageKinds())
  const startExistingWorkspaceWatches = () => {
    for (const workspace of workspaceStore.listWorkspaces()) {
      void tasksFileWatcher.start(workspace.id, workspace.path)
    }
  }
  const restartPolicy = buildRuntimeRestartPolicy({
    agentRunStore,
    messageLogStore,
    tasksFileService,
    workspaceStore,
  })
  const agentRuntime = createAgentRuntime(
    options.agentManager,
    agentRunStore,
    agentSessionStore,
    settings.getCommandPreset,
    (workspaceId, agentId) => {
      workspaceStore.markAgentStopped(workspaceId, agentId)
    },
    restartPolicy
  )
  const teamOps = createTeamOperations({
    agentRuntime,
    deleteMessage: messageLogStore.deleteMessage,
    insertMessage: messageLogStore.insertMessage,
    workspaceStore,
  })
  startExistingWorkspaceWatches()

  return {
    agentRunStore,
    agentRuntime,
    db,
    messageLogStore,
    settings,
    tasksFileWatcher,
    tasksFileWatchCallbacks,
    tasksFileService,
    teamOps,
    uiAuth,
    workspaceStore,
  }
}

export const createRuntimeStoreLifecycle = ({
  agentManager,
  services,
}: CreateRuntimeStoreLifecycleOptions) => ({
  close: async () => {
    await services.agentRuntime.close()
    await services.tasksFileWatcher.close()
    services.agentRunStore.close?.()
    services.db?.close()
  },
  configureAgentLaunch: (workspaceId: string, agentId: string, input: AgentLaunchConfigInput) => {
    services.workspaceStore.getAgent(workspaceId, agentId)
    services.agentRuntime.configureAgentLaunch(workspaceId, agentId, input)
  },
  getPtyOutputBus: (): PtyOutputBus => {
    if (!agentManager) throw new Error('Agent manager is required for PTY output subscriptions')
    return agentManager.getOutputBus()
  },
  listTerminalRuns: (workspaceId: string) =>
    services.workspaceStore.getWorkspaceSnapshot(workspaceId).agents.flatMap((agent) => {
      const run = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
      if (!run) return []
      return [{ agent_id: agent.id, agent_name: agent.name, run_id: run.runId, status: run.status }]
    }),
  startAgent: async (
    workspaceId: string,
    agentId: string,
    input: { hivePort: string }
  ): Promise<LiveAgentRun> => {
    services.workspaceStore.getAgent(workspaceId, agentId)
    services.workspaceStore.markAgentStarted(workspaceId, agentId)
    try {
      const run = await services.agentRuntime.startAgent(
        services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
        agentId,
        input
      )
      if (run.status === 'error') {
        services.workspaceStore.markAgentStopped(workspaceId, agentId)
      }
      return run
    } catch (error) {
      services.workspaceStore.markAgentStopped(workspaceId, agentId)
      throw error
    }
  },
  registerTasksListener: (listener: (workspaceId: string, content: string) => void) => {
    services.tasksFileWatchCallbacks.add(listener)
    return () => {
      services.tasksFileWatchCallbacks.delete(listener)
    }
  },
  startWorkspaceWatch: async (workspaceId: string) => {
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
    await services.tasksFileWatcher.start(workspaceId, workspace.summary.path)
  },
  writeRunInput: (runId: string, text: string) => {
    if (!agentManager) throw new Error('Agent manager is required for PTY stdin writes')
    agentManager.writeInput(runId, text)
  },
})
