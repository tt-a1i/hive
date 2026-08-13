import type { AgentManager } from './agent-manager.js'
import { type AgentLaunchConfigInput, createAgentRunStore } from './agent-run-store.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentSessionStore } from './agent-session-store.js'
import { createDiscussionOperations } from './discussion-operations.js'
import { createDispatchLedgerStore } from './dispatch-ledger-store.js'
import { createMessageLogStore } from './message-log-store.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { openRuntimeDatabase } from './runtime-database.js'
import { buildRuntimeRestartPolicy } from './runtime-restart-policy.js'
import { createSettingsStore } from './settings-store.js'
import { createTaskService } from './task-service.js'
import { createTasksFileService } from './tasks-file.js'
import { createTasksFileWatcher } from './tasks-file-watcher.js'
import { createTeamOperations } from './team-operations.js'
import { resolveTerminalInputProfile } from './terminal-input-profile.js'
import { createUiAuth } from './ui-auth.js'
import { createWorkerOutputTracker, type WorkerOutputTracker } from './worker-output-tracker.js'
import { createWorkspaceShellRuntime } from './workspace-shell-runtime.js'
import { createWorkspaceStore } from './workspace-store.js'
import { reattachSurvivedSessions } from './tmux-reattach.js'

export interface RuntimeStoreServices {
  agentRunStore: ReturnType<typeof createAgentRunStore>
  agentRuntime: ReturnType<typeof createAgentRuntime>
  db: ReturnType<typeof openRuntimeDatabase>
  dispatchLedgerStore: ReturnType<typeof createDispatchLedgerStore>
  messageLogStore: ReturnType<typeof createMessageLogStore>
  settings: ReturnType<typeof createSettingsStore>
  shellRuntime: ReturnType<typeof createWorkspaceShellRuntime>
  tasksFileWatcher: ReturnType<typeof createTasksFileWatcher>
  tasksFileWatchCallbacks: Set<(workspaceId: string, content: string) => void>
  tasksFileService: ReturnType<typeof createTasksFileService>
  teamOps: ReturnType<typeof createTeamOperations>
  taskService: ReturnType<typeof createTaskService>
  uiAuth: ReturnType<typeof createUiAuth>
  workerOutputTracker: WorkerOutputTracker | null
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
  const dispatchLedgerStore = createDispatchLedgerStore(db)
  const taskService = createTaskService(db)
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
  const shellRuntime = createWorkspaceShellRuntime(options.agentManager)

  agentRunStore.markUnfinishedRunsStale()

  const discussionOps = createDiscussionOperations(db)
  const workspaceStore = createWorkspaceStore(
    db,
    dispatchLedgerStore.listOpenDispatchKinds(),
    (workspaceId, agentId) => discussionOps.getActiveGroupForAgent(workspaceId, agentId) !== null
  )
  const startExistingWorkspaceWatches = () => {
    for (const workspace of workspaceStore.listWorkspaces()) {
      void tasksFileWatcher.start(workspace.id, workspace.path)
    }
  }
  const restartPolicy = buildRuntimeRestartPolicy({
    agentRunStore,
    discussionOps,
    dispatchLedgerStore,
    messageLogStore,
    tasksFileService,
    workspaceStore,
  })
  const workerOutputTracker = options.agentManager
    ? createWorkerOutputTracker(options.agentManager.getOutputBus())
    : null
  const agentRuntime = createAgentRuntime(
    options.agentManager,
    agentRunStore,
    agentSessionStore,
    settings.getCommandPreset,
    (workspaceId, agentId) => {
      workerOutputTracker?.detach(workspaceId, agentId)
      if (!workspaceStore.hasAgent(workspaceId, agentId)) return
      workspaceStore.markAgentStopped(workspaceId, agentId)
    },
    restartPolicy,
    (workspaceId, agentId) => workspaceStore.getAgent(workspaceId, agentId)
  )
  const teamOps = createTeamOperations({
    agentRuntime,
    createDispatch: dispatchLedgerStore.createDispatch,
    deleteDispatch: dispatchLedgerStore.deleteDispatch,
    deleteMessage: messageLogStore.deleteMessage,
    findOpenDispatch: dispatchLedgerStore.findOpenDispatch,
    findOpenDispatchById: dispatchLedgerStore.findOpenDispatchById,
    insertMessage: messageLogStore.insertMessage,
    markDispatchCancelled: dispatchLedgerStore.markCancelled,
    markDispatchReportedByWorker: dispatchLedgerStore.markReportedByWorker,
    markDispatchSubmitted: dispatchLedgerStore.markSubmitted,
    workspaceStore,
  })
  startExistingWorkspaceWatches()

  return {
    agentRunStore,
    agentRuntime,
    db,
    dispatchLedgerStore,
    messageLogStore,
    settings,
    shellRuntime,
    taskService,
    tasksFileWatcher,
    tasksFileWatchCallbacks,
    tasksFileService,
    teamOps,
    uiAuth,
    workerOutputTracker,
    workspaceStore,
  }
}

export const createRuntimeStoreLifecycle = ({
  agentManager,
  services,
}: CreateRuntimeStoreLifecycleOptions) => {
  const startAgent = async (
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
      } else {
        services.workerOutputTracker?.attach(workspaceId, agentId, run.runId, run.output)
      }
      return run
    } catch (error) {
      services.workspaceStore.markAgentStopped(workspaceId, agentId)
      throw error
    }
  }

  const autostartConfiguredAgents = async (input: { hivePort: string }) => {
    if (!agentManager) return []
    const starts = services.workspaceStore.listWorkspaces().flatMap((workspace) => {
      seedOrchestratorLaunchConfig(services.agentRuntime, services.settings, workspace.id)
      return services.workspaceStore
        .getWorkspaceSnapshot(workspace.id)
        .agents.filter(
          (agent) =>
            !services.agentRuntime.getActiveRunByAgentId(workspace.id, agent.id) &&
            services.agentRuntime.peekAgentLaunchConfig(workspace.id, agent.id)
        )
        .map(async (agent) => {
          try {
            const run = await startAgent(workspace.id, agent.id, input)
            return {
              agent_id: agent.id,
              error: null,
              ok: true,
              run_id: run.runId,
              workspace_id: workspace.id,
            }
          } catch (error) {
            return {
              agent_id: agent.id,
              error: error instanceof Error ? error.message : String(error),
              ok: false,
              run_id: null,
              workspace_id: workspace.id,
            }
          }
        })
    })
    return Promise.all(starts)
  }

  return {
    close: async () => {
      services.shellRuntime.close()
      await services.agentRuntime.close()
      await services.tasksFileWatcher.close()
      services.workerOutputTracker?.closeAll()
      services.agentRunStore.close?.()
      services.db.close()
    },
    configureAgentLaunch: (workspaceId: string, agentId: string, input: AgentLaunchConfigInput) => {
      services.workspaceStore.getAgent(workspaceId, agentId)
      services.agentRuntime.configureAgentLaunch(workspaceId, agentId, input)
    },
    peekAgentLaunchConfig: (workspaceId: string, agentId: string) =>
      services.agentRuntime.peekAgentLaunchConfig(workspaceId, agentId),
    deleteWorkspaceShell: (workspaceId: string) => {
      services.shellRuntime.deleteWorkspace(workspaceId)
    },
    closeWorkspaceShell: (workspaceId: string, runId: string) =>
      services.shellRuntime.closeRun(workspaceId, runId),
    getLiveRun: (runId: string) =>
      services.shellRuntime.getLiveRun(runId) ?? services.agentRuntime.getLiveRun(runId),
    getPtyOutputBus: (): PtyOutputBus => {
      if (!agentManager) throw new Error('Agent manager is required for PTY output subscriptions')
      return agentManager.getOutputBus()
    },
    listTerminalRuns: (workspaceId: string) => [
      ...services.workspaceStore.getWorkspaceSnapshot(workspaceId).agents.flatMap((agent) => {
        const run = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (!run) return []
        const launchConfig = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agent.id)
        return [
          {
            agent_id: agent.id,
            agent_name: agent.name,
            run_id: run.runId,
            status: run.status,
            terminal_input_profile: resolveTerminalInputProfile(launchConfig),
          },
        ]
      }),
      ...services.shellRuntime.listTerminalRuns(workspaceId),
    ],
    startAgent,
    startWorkspaceShell: (workspaceId: string) =>
      services.shellRuntime.start(
        services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary
      ),
    autostartConfiguredAgents,
    reattachTmuxSessions: () => {
      if (!agentManager) return 0
      return reattachSurvivedSessions({
        agentManager,
        agentRunStore: services.agentRunStore,
        registry: services.agentRuntime.getLiveRunRegistry(),
      })
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
    writeRunInput: (runId: string, input: Buffer | string) => {
      if (!agentManager) throw new Error('Agent manager is required for PTY stdin writes')
      if (services.shellRuntime.hasRun(runId)) {
        services.shellRuntime.writeInput(runId, input)
        return
      }
      agentManager.writeInput(runId, input)
    },
    pauseTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.pauseRun(runId)
      else services.agentRuntime.pauseRun(runId)
    },
    resizeTerminalRun: (runId: string, cols: number, rows: number) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.resizeRun(runId, cols, rows)
      else services.agentRuntime.resizeAgentRun(runId, cols, rows)
    },
    resumeTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.resumeRun(runId)
      else services.agentRuntime.resumeRun(runId)
    },
    stopTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.stopRun(runId)
      else services.agentRuntime.stopAgentRun(runId)
    },
  }
}
