import type { RuntimeStore, RuntimeStoreOptions } from './runtime-store-contract.js'
import { createRuntimeStoreController } from './runtime-store-controller.js'
import { createRuntimeStoreDiagnosticsMethods } from './runtime-store-diagnostics.js'
import { createRuntimeStoreDreamMethods } from './runtime-store-dream.js'
import { createRuntimeStoreExternalGoalMethods } from './runtime-store-external-goals.js'
import {
  createRuntimeStoreLifecycle,
  createRuntimeStoreServices,
  logTasksFileWatchStartError,
} from './runtime-store-helpers.js'
import { createRuntimeStoreMemoryMethods } from './runtime-store-memory.js'
import { createRuntimeStoreRemoteMethods } from './runtime-store-remote.js'
import { createRuntimeStoreShutdown } from './runtime-store-shutdown.js'
import { createRuntimeStoreWorkerMutations } from './runtime-store-worker-mutations.js'
import { createRuntimeStoreWorkflowRuntime } from './runtime-store-workflows.js'
import type { WorkflowRunRecord } from './workflow-run-store.js'
import { persistWorkflowSchedule } from './workflow-schedule-create.js'
import type { StagedWorkspaceUploadsDelete } from './workspace-upload-store.js'

export type { RuntimeStore, WorkflowRunRecord }

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
  let workflowRuntime: ReturnType<typeof createRuntimeStoreWorkflowRuntime> | undefined
  const getWorkflowRuntime = () => {
    if (!workflowRuntime) throw new Error('Workflow runtime not initialized')
    return workflowRuntime
  }
  let store: RuntimeStore
  const controller = createRuntimeStoreController(services, () => store)
  const workerMutations = createRuntimeStoreWorkerMutations({
    addWorker: (workspaceId, input) => store.addWorker(workspaceId, input),
    configureAgentLaunch: (workspaceId, agentId, input) =>
      store.configureAgentLaunch(workspaceId, agentId, input),
    deleteWorker: (workspaceId, workerId) => store.deleteWorker(workspaceId, workerId),
    runDataMutation,
    services,
  })
  store = {
    ...controller.methods,
    close: createRuntimeStoreShutdown(services, controller, lifecycle, () => workflowRuntime),
    createWorkspace: (path, name, controllerMode) => {
      const workspace = services.workspaceStore.createWorkspace(path, name, controllerMode)
      void lifecycle
        .startWorkspaceWatch(workspace.id)
        .catch((error) => logTasksFileWatchStartError(workspace.id, error))
      return workspace
    },
    listWorkspaces: () => services.workspaceStore.listWorkspaces(),
    deleteWorkspace: async (workspaceId) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      lifecycle.deleteWorkspaceShell(workspaceId)
      for (const agent of workspace.agents) {
        const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
        services.agentRuntime.deleteAgentLaunchConfig(workspaceId, agent.id)
      }
      await services.tasksFileWatcher.stop(workspaceId)
      services.teamMemoryExport.cancel(workspaceId)
      // Upload blobs are only tombstoned (renamed) inside the transaction and
      // permanently unlinked after COMMIT, so a failed commit restores them
      // instead of resurrecting a workspace whose attachments all 404.
      let stagedUploads: StagedWorkspaceUploadsDelete | undefined
      try {
        runDataMutation(() => {
          services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
          services.externalGoalStore.deleteWorkspaceGoals(workspaceId)
          services.teamMemoryStore.deleteWorkspaceMemories(workspaceId)
          services.teamMemoryDreamStore.deleteWorkspaceDreamRuns(workspaceId)
          services.workspaceStore.deleteWorkspaceData(workspaceId)
          stagedUploads = services.workspaceUploadStore.stageWorkspaceUploadsDelete(workspaceId)
        })
      } catch (error) {
        stagedUploads?.rollback()
        throw error
      }
      stagedUploads?.commit()
      services.workspaceStore.forgetWorkspace(workspaceId)
      if (services.settings.getAppState('active_workspace_id')?.value === workspaceId) {
        services.settings.setAppState('active_workspace_id', null)
      }
    },
    addWorker: (workspaceId, input) => services.workspaceStore.addWorker(workspaceId, input),
    addWorkerWithLaunch: workerMutations.addWorkerWithLaunch,
    updateWorkerProfile: (workspaceId, workerId, input) =>
      services.workspaceStore.updateWorkerProfile(workspaceId, workerId, input),
    updateWorkerAvatar: (workspaceId, workerId, avatar) =>
      services.workspaceStore.updateWorkerAvatar(workspaceId, workerId, avatar),
    renameWorker: (workspaceId, workerId, name) =>
      services.workspaceStore.renameWorker(workspaceId, workerId, name),
    deleteWorker: workerMutations.deleteWorker,
    recordUserInput: services.teamOps.recordUserInput,
    deliverUserInput: services.teamOps.deliverUserInput,
    cancelTask: services.teamOps.cancelTask,
    dispatchTask: services.teamOps.dispatchTask,
    dispatchTaskByWorkerName: services.teamOps.dispatchTaskByWorkerName,
    reportTask: controller.reportTask,
    drainReportOutbox: services.teamOps.drainReportOutbox,
    statusTask: controller.statusTask,
    ...services.dispatchMessageOps,
    listDispatches: services.dispatchLedgerStore.listWorkspaceDispatches,
    getDispatch: services.dispatchLedgerStore.getDispatch,
    listOpenDispatches: services.dispatchLedgerStore.listOpenWorkspaceDispatches,
    listRecentDispatches: services.dispatchLedgerStore.listRecentWorkspaceDispatches,
    ...createRuntimeStoreExternalGoalMethods(services),
    listWorkers: (workspaceId) => services.workspaceStore.listWorkers(workspaceId),
    getLastPtyLineForAgent: (workspaceId, agentId) =>
      services.workerOutputTracker?.getLastPtyLine(workspaceId, agentId) ?? null,
    getWorkspaceSnapshot: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId),
    getWorker: (workspaceId, workerId) => services.workspaceStore.getWorker(workspaceId, workerId),
    getAgent: (workspaceId, agentId) => services.workspaceStore.getAgent(workspaceId, agentId),
    getPtyOutputBus: lifecycle.getPtyOutputBus,
    listTerminalRuns: lifecycle.listTerminalRuns,
    closeWorkspaceShell: lifecycle.closeWorkspaceShell,
    configureAgentLaunch: lifecycle.configureAgentLaunch,
    peekAgentLaunchConfig: lifecycle.peekAgentLaunchConfig,
    startAgent: lifecycle.startAgent,
    autostartConfiguredAgents: lifecycle.autostartConfiguredAgents,
    startWorkspaceWatch: lifecycle.startWorkspaceWatch,
    startWorkspaceShell: lifecycle.startWorkspaceShell,
    findLiveRun: lifecycle.findLiveRun,
    getLiveRun: lifecycle.getLiveRun,
    waitForRunExit: lifecycle.waitForRunExit,
    getActiveRunByAgentId: (workspaceId, agentId) =>
      services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
    registerTasksListener: lifecycle.registerTasksListener,
    listAgentRuns: (agentId) => services.agentRuntime.listAgentRuns(agentId),
    listMessagesForRecovery: (workspaceId, sinceMs) =>
      services.messageLogStore.listMessagesForRecovery(workspaceId, sinceMs),
    recallMessages: (workspaceId, query, options) =>
      services.teamRecallStore.recallMessages(workspaceId, query, options),
    ...createRuntimeStoreMemoryMethods(services),
    ...createRuntimeStoreDreamMethods(services),
    peekAgentToken: (agentId) => services.agentRuntime.peekAgentToken(agentId),
    pauseTerminalRun: lifecycle.pauseTerminalRun,
    resizeAgentRun: lifecycle.resizeTerminalRun,
    resumeTerminalRun: lifecycle.resumeTerminalRun,
    settings: services.settings,
    writeRunInput: lifecycle.writeRunInput,
    getUiToken: () => services.uiAuth.getToken(),
    getSupervisorToken: () => services.uiAuth.getSupervisorToken(),
    stopAgentRun: lifecycle.stopTerminalRun,
    validateAgentToken: (agentId, token) =>
      services.agentRuntime.validateAgentToken(agentId, token),
    validateUiToken: (token) => services.uiAuth.validate(token),
    validateSupervisorToken: (token) => services.uiAuth.validateSupervisorToken(token),
    ...createRuntimeStoreDiagnosticsMethods(services),
    ...createRuntimeStoreRemoteMethods(services),
    getWorkflowDispatchAwaiter: () => services.workflowDispatchAwaiter,
    runWorkflow: (input) => getWorkflowRuntime().runner.runWorkflow(input),
    startWorkflow: (input) => getWorkflowRuntime().runner.startWorkflow(input),
    startWorkflowInline: (input) => getWorkflowRuntime().runner.startWorkflowInline(input),
    stopWorkflowRun: (runId) => getWorkflowRuntime().runner.stopRun(runId),
    getWorkflowRun: (runId) => services.workflowRunStore.getRun(runId),
    listWorkspaceWorkflowRuns: (workspaceId) =>
      services.workflowRunStore.listWorkspaceRuns(workspaceId),
    listWorkflowRunDispatches: (runId) =>
      services.dispatchLedgerStore.listWorkflowRunDispatches(runId),
    listWorkflowRunLogs: (runId) =>
      services.workflowRunLogStore.listForRun(runId).map((row) => ({
        id: row.id,
        ts: row.ts,
        message: row.message,
      })),
    saveWorkspaceUpload: (input) => services.workspaceUploadStore.saveUpload(input),
    listWorkspaceUploads: (workspaceId, limit) =>
      services.workspaceUploadStore.listUploads(workspaceId, limit),
    readWorkspaceUpload: (workspaceId, uploadId) =>
      services.workspaceUploadStore.readUpload(workspaceId, uploadId),
    createWorkflowSchedule: (input) => services.workflowScheduleStore.create(input),
    scheduleWorkflowInline: (input) =>
      persistWorkflowSchedule({
        workspacePath: services.workspaceStore.getWorkspaceSnapshot(input.workspaceId).summary.path,
        scheduleStore: services.workflowScheduleStore,
        ...input,
      }),
    updateWorkflowSchedule: (id, input) => services.workflowScheduleStore.update(id, input),
    getWorkflowSchedule: (id) => services.workflowScheduleStore.get(id),
    listWorkspaceWorkflowSchedules: (workspaceId) =>
      services.workflowScheduleStore.listForWorkspace(workspaceId),
    deleteWorkflowSchedule: (id) => services.workflowScheduleStore.deleteSchedule(id),
  }
  workflowRuntime = createRuntimeStoreWorkflowRuntime(services, store)
  return store
}
