import type { AgentSummary, TeamListItem, WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import type { RecoveryMessage } from './message-log-store.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { createRuntimeStoreLifecycle, createRuntimeStoreServices } from './runtime-store-helpers.js'
import type { SettingsStore } from './settings-store.js'
import type { DispatchTaskInput, ReportTaskInput } from './team-operations.js'
import type { WorkerInput, WorkspaceRecord } from './workspace-store.js'

interface RuntimeStore {
  close: () => Promise<void>
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => Promise<void>
  listWorkspaces: () => WorkspaceSummary[]
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  deleteWorker: (workspaceId: string, workerId: string) => void
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentSummary
  recordUserInput: (workspaceId: string, orchestratorId: string, text: string) => void
  dispatchTask: (
    workspaceId: string,
    workerId: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  dispatchTaskByWorkerName: (
    workspaceId: string,
    workerName: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  reportTask: (workspaceId: string, workerId: string, input?: ReportTaskInput) => DispatchRecord
  listDispatches: (workspaceId: string, options?: ListDispatchesOptions) => DispatchRecord[]
  listWorkers: (workspaceId: string) => TeamListItem[]
  getLastOutputLineForAgent: (workspaceId: string, agentId: string) => string | null
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getPtyOutputBus: () => PtyOutputBus
  listTerminalRuns: (workspaceId: string) => Array<{
    agent_id: string
    agent_name: string
    run_id: string
    status: string
  }>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  autostartConfiguredAgents: (input: StartAgentOptions) => Promise<
    Array<{
      agent_id: string
      error: string | null
      ok: boolean
      run_id: string | null
      workspace_id: string
    }>
  >
  startWorkspaceWatch: (workspaceId: string) => Promise<void>
  getLiveRun: (runId: string) => LiveAgentRun
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  registerTasksListener: (listener: (workspaceId: string, content: string) => void) => () => void
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  peekAgentToken: (agentId: string) => string | undefined
  pauseTerminalRun: (runId: string) => void
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeTerminalRun: (runId: string) => void
  settings: SettingsStore
  writeRunInput: (runId: string, text: string) => void
  getUiToken: () => string
  stopAgentRun: (runId: string) => void
  validateAgentToken: (agentId: string, token: string | undefined) => boolean
  validateUiToken: (token: string | undefined) => boolean
}

interface RuntimeStoreOptions {
  dataDir?: string
  agentManager?: AgentManager
}

interface StartAgentOptions {
  hivePort: string
}

export type { RuntimeStore }

export const createRuntimeStore = (options: RuntimeStoreOptions = {}): RuntimeStore => {
  const services = createRuntimeStoreServices(options)
  const lifecycle = createRuntimeStoreLifecycle(
    options.agentManager ? { agentManager: options.agentManager, services } : { services }
  )
  const runDataMutation = (mutation: () => void) => {
    if (!services.db) {
      mutation()
      return
    }
    services.db.transaction(mutation)()
  }
  return {
    close: lifecycle.close,
    createWorkspace: (path, name) => {
      const workspace = services.workspaceStore.createWorkspace(path, name)
      void lifecycle.startWorkspaceWatch(workspace.id)
      return workspace
    },
    listWorkspaces: () => services.workspaceStore.listWorkspaces(),
    deleteWorkspace: async (workspaceId) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      for (const agent of workspace.agents) {
        const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
        services.agentRuntime.deleteAgentLaunchConfig(workspaceId, agent.id)
      }
      await services.tasksFileWatcher.stop(workspaceId)
      runDataMutation(() => {
        services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
        services.workspaceStore.deleteWorkspace(workspaceId)
      })
      if (services.settings.getAppState('active_workspace_id')?.value === workspaceId) {
        services.settings.setAppState('active_workspace_id', null)
      }
    },
    addWorker: (workspaceId, input) => services.workspaceStore.addWorker(workspaceId, input),
    renameWorker: (workspaceId, workerId, name) =>
      services.workspaceStore.renameWorker(workspaceId, workerId, name),
    deleteWorker: (workspaceId, workerId) => {
      const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
      if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
      services.agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
      runDataMutation(() => {
        services.dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
        services.workspaceStore.deleteWorker(workspaceId, workerId)
      })
    },
    recordUserInput: services.teamOps.recordUserInput,
    dispatchTask: services.teamOps.dispatchTask,
    dispatchTaskByWorkerName: services.teamOps.dispatchTaskByWorkerName,
    reportTask: services.teamOps.reportTask,
    listDispatches: services.dispatchLedgerStore.listWorkspaceDispatches,
    listWorkers: (workspaceId) => services.workspaceStore.listWorkers(workspaceId),
    getLastOutputLineForAgent: (workspaceId, agentId) =>
      services.workerOutputTracker?.getLastOutputLine(workspaceId, agentId) ?? null,
    getWorkspaceSnapshot: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId),
    getWorker: (workspaceId, workerId) => services.workspaceStore.getWorker(workspaceId, workerId),
    getAgent: (workspaceId, agentId) => services.workspaceStore.getAgent(workspaceId, agentId),
    getPtyOutputBus: lifecycle.getPtyOutputBus,
    listTerminalRuns: lifecycle.listTerminalRuns,
    configureAgentLaunch: lifecycle.configureAgentLaunch,
    peekAgentLaunchConfig: lifecycle.peekAgentLaunchConfig,
    startAgent: lifecycle.startAgent,
    autostartConfiguredAgents: lifecycle.autostartConfiguredAgents,
    startWorkspaceWatch: lifecycle.startWorkspaceWatch,
    getLiveRun: (runId) => services.agentRuntime.getLiveRun(runId),
    getActiveRunByAgentId: (workspaceId, agentId) =>
      services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
    registerTasksListener: lifecycle.registerTasksListener,
    listAgentRuns: (agentId) => services.agentRuntime.listAgentRuns(agentId),
    listMessagesForRecovery: (workspaceId, sinceMs) =>
      services.messageLogStore.listMessagesForRecovery(workspaceId, sinceMs),
    peekAgentToken: (agentId) => services.agentRuntime.peekAgentToken(agentId),
    pauseTerminalRun: (runId) => services.agentRuntime.pauseRun(runId),
    resizeAgentRun: (runId, cols, rows) => services.agentRuntime.resizeAgentRun(runId, cols, rows),
    resumeTerminalRun: (runId) => services.agentRuntime.resumeRun(runId),
    settings: services.settings,
    writeRunInput: lifecycle.writeRunInput,
    getUiToken: () => services.uiAuth.getToken(),
    stopAgentRun: (runId) => services.agentRuntime.stopAgentRun(runId),
    validateAgentToken: (agentId, token) =>
      services.agentRuntime.validateAgentToken(agentId, token),
    validateUiToken: (token) => services.uiAuth.validate(token),
  }
}
