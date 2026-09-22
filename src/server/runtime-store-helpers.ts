import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentManager } from './agent-manager.js'
import { type AgentLaunchConfigInput, createAgentRunStore } from './agent-run-store.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentSessionStore } from './agent-session-store.js'
import { createDispatchLedgerStore } from './dispatch-ledger-store.js'
import { createDispatchMessageOperations } from './dispatch-message-operations.js'
import { createDispatchMessageStore } from './dispatch-message-store.js'
import { createExternalGoalStore } from './external-goal-store.js'
import { readFeatureFlags } from './feature-flags.js'
import { ConflictError } from './http-errors.js'
import { createMessageLogStore } from './message-log-store.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import { hasFirstRunSetupPrompt, isInteractiveAgentCommand } from './post-start-input-writer.js'
import { createProtocolEventStats } from './protocol-event-stats.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { createRemoteAuditStore, type RemoteAuditStore } from './remote-audit-store.js'
import { REMOTE_DAEMON_ID_KEY, REMOTE_GATEWAY_URL_KEY } from './remote-config-keys.js'
import type { DeviceSessionProvider } from './remote-device-session.js'
import {
  createPersistentDeviceSessionProvider,
  createRemoteDeviceStore,
  type RemoteDeviceStore,
} from './remote-device-store.js'
import { createRemotePairing, type RemotePairing } from './remote-pairing.js'
import { createReportOutboxStore } from './report-outbox-store.js'
import { openRuntimeDatabase } from './runtime-database.js'
import { buildRuntimeRestartPolicy } from './runtime-restart-policy.js'
import { createSettingsStore } from './settings-store.js'
import { createTasksFileService } from './tasks-file.js'
import { createTasksFileWatcher } from './tasks-file-watcher.js'
import { createTeamMemoryDiagnostics } from './team-memory-diagnostics.js'
import { createWorkspaceMemoryDigestProvider } from './team-memory-digest.js'
import { createDreamCliExecutor } from './team-memory-dream-cli.js'
import { buildMemoryDreamInput } from './team-memory-dream-input.js'
import { createTeamMemoryDreamRunner } from './team-memory-dream-runner.js'
import { createTeamMemoryDreamScheduler } from './team-memory-dream-scheduler.js'
import { createTeamMemoryDreamStore } from './team-memory-dream-store.js'
import {
  createTeamMemoryExportService,
  MEMORY_EXPORT_DREAM_CHANGELOG_LIMIT,
} from './team-memory-export.js'
import { createLocalTeamMemoryProvider } from './team-memory-provider.js'
import { createTeamMemoryStore } from './team-memory-store.js'
import { createTeamOperations } from './team-operations.js'
import { createTeamRecallStore } from './team-recall-store.js'
import { resolveTerminalInputProfile } from './terminal-input-profile.js'
import { createUiAuth } from './ui-auth.js'
import { createWebhookNotifier, WEBHOOK_URL_KEY } from './webhook-notifier.js'
import { createWorkerOutputTracker, type WorkerOutputTracker } from './worker-output-tracker.js'
import { readWorkflowCliPolicy, WORKFLOW_CLI_POLICY_KEY } from './workflow-cli-policy.js'
import {
  createWorkflowDispatchAwaiter,
  type WorkflowDispatchAwaiter,
} from './workflow-dispatch-awaiter.js'
import { createWorkflowRunLogStore } from './workflow-run-log-store.js'
import { createWorkflowRunStore } from './workflow-run-store.js'
import { createWorkflowScheduleStore } from './workflow-schedule-store.js'
import { cleanupOrphanedWorkflowWorktree } from './workflow-worktree.js'
import { createWorkspaceShellRuntime } from './workspace-shell-runtime.js'
import { createWorkspaceStore } from './workspace-store.js'
import { getOrchestratorId } from './workspace-store-support.js'
import { createWorkspaceUploadStore } from './workspace-upload-store.js'

export interface RuntimeStoreServices {
  dispatchMessageStore: ReturnType<typeof createDispatchMessageStore>
  dispatchMessageOps: ReturnType<typeof createDispatchMessageOperations>
  agentRunStore: ReturnType<typeof createAgentRunStore>
  agentRuntime: ReturnType<typeof createAgentRuntime>
  db: ReturnType<typeof openRuntimeDatabase>
  dispatchLedgerStore: ReturnType<typeof createDispatchLedgerStore>
  externalGoalStore: ReturnType<typeof createExternalGoalStore>
  isRuntimeClosing: () => boolean
  markRuntimeClosing: () => void
  messageLogStore: ReturnType<typeof createMessageLogStore>
  // Remote-access (M3/M4): the single audit sink + the PERSISTENT device-session seam + the daemon
  // pairing engine + the device store. Built once on the shared db so they live for the runtime's
  // lifetime; all inert until the gated tunnel forwards remote traffic / a device is confirmed
  // (invariant 4 — off == zero behavior change; the provider serves nothing until a confirm writes a
  // row, and the engine is armed by nothing until the desktop-only beginPairing route is hit).
  remoteAuditStore: RemoteAuditStore
  remoteDeviceSessions: DeviceSessionProvider
  remoteDeviceStore: RemoteDeviceStore
  remotePairing: RemotePairing
  settings: ReturnType<typeof createSettingsStore>
  shellRuntime: ReturnType<typeof createWorkspaceShellRuntime>
  tasksFileWatcher: ReturnType<typeof createTasksFileWatcher>
  tasksFileWatchCallbacks: Set<(workspaceId: string, content: string) => void>
  tasksFileService: ReturnType<typeof createTasksFileService>
  teamMemoryDreamRunner: ReturnType<typeof createTeamMemoryDreamRunner>
  teamMemoryDreamScheduler: ReturnType<typeof createTeamMemoryDreamScheduler>
  protocolEventStats: ReturnType<typeof createProtocolEventStats>
  reportOutbox: ReturnType<typeof createReportOutboxStore>
  teamMemoryDreamStore: ReturnType<typeof createTeamMemoryDreamStore>
  teamMemoryDiagnostics: ReturnType<typeof createTeamMemoryDiagnostics>
  teamMemoryStore: ReturnType<typeof createTeamMemoryStore>
  teamMemoryExport: ReturnType<typeof createTeamMemoryExportService>
  teamMemoryProvider: ReturnType<typeof createLocalTeamMemoryProvider>
  teamRecallStore: ReturnType<typeof createTeamRecallStore>
  teamOps: ReturnType<typeof createTeamOperations>
  uiAuth: ReturnType<typeof createUiAuth>
  webhookNotifier: ReturnType<typeof createWebhookNotifier>
  workerOutputTracker: WorkerOutputTracker | null
  workflowDispatchAwaiter: WorkflowDispatchAwaiter
  workflowRunLogStore: ReturnType<typeof createWorkflowRunLogStore>
  workflowRunStore: ReturnType<typeof createWorkflowRunStore>
  workflowScheduleStore: ReturnType<typeof createWorkflowScheduleStore>
  workspaceStore: ReturnType<typeof createWorkspaceStore>
  workspaceUploadStore: ReturnType<typeof createWorkspaceUploadStore>
  workspaceUploadStorageCleanup: () => void
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

export const logTasksFileWatchStartError = (workspaceId: string, error: unknown) => {
  console.error(`[hive] failed to start tasks watcher for workspace ${workspaceId}`, error)
}

const createWorkspaceUploadStorage = (dataDir: string | undefined) => {
  if (dataDir) {
    return {
      cleanup: () => {},
      uploadsDir: join(dataDir, 'uploads'),
    }
  }

  const uploadsDir = mkdtempSync(join(tmpdir(), 'hive-uploads-'))
  return {
    cleanup: () => {
      try {
        rmSync(uploadsDir, { force: true, recursive: true })
      } catch {
        // Best-effort cleanup for ephemeral in-memory runtimes.
      }
    },
    uploadsDir,
  }
}

export const createRuntimeStoreServices = (
  options: CreateRuntimeStoreServicesOptions = {}
): RuntimeStoreServices => {
  const db = openRuntimeDatabase(options.dataDir)
  let closing = false
  const uploadStorage = createWorkspaceUploadStorage(options.dataDir)
  const messageLogStore = createMessageLogStore(db)
  const dispatchLedgerStore = createDispatchLedgerStore(db)
  const dispatchMessageStore = createDispatchMessageStore(db)
  const externalGoalStore = createExternalGoalStore(db)
  const teamMemoryStore = createTeamMemoryStore(db)
  const teamMemoryDreamStore = createTeamMemoryDreamStore(db)
  const teamRecallStore = createTeamRecallStore(db)
  const reportOutbox = createReportOutboxStore(db)
  const workflowDispatchAwaiter = createWorkflowDispatchAwaiter()
  const workflowRunStore = createWorkflowRunStore(db)
  const workflowRunLogStore = createWorkflowRunLogStore(db)
  const workflowScheduleStore = createWorkflowScheduleStore(db)
  const agentRunStore = createAgentRunStore(db)
  const agentSessionStore = createAgentSessionStore(db)
  const settings = createSettingsStore(db)
  const getFlags = () => readFeatureFlags(settings)
  const teamMemoryProvider = createLocalTeamMemoryProvider({ memoryStore: teamMemoryStore })
  const teamMemoryDreamCli = createDreamCliExecutor()
  const teamMemoryDiagnostics = createTeamMemoryDiagnostics({
    dreamStore: teamMemoryDreamStore,
    memoryProvider: teamMemoryProvider,
    memoryStore: teamMemoryStore,
  })
  const memoryDigestProvider = createWorkspaceMemoryDigestProvider({
    memoryStore: teamMemoryProvider,
    settings,
  })
  const memoryInjection = {
    buildDigest: memoryDigestProvider.buildDigest,
    buildDispatchDigest: memoryDigestProvider.buildDispatchDigest,
    deleteInjections: teamMemoryStore.deleteInjections,
    logInjections: teamMemoryStore.logInjections,
  }
  const webhookNotifier = createWebhookNotifier({
    getUrl: () => settings.getAppState(WEBHOOK_URL_KEY)?.value ?? null,
  })
  const tasksFileService = createTasksFileService()
  const tasksFileWatchCallbacks = new Set<(workspaceId: string, content: string) => void>()
  const tasksFileWatcher = createTasksFileWatcher({
    onTasksUpdated: (workspaceId, content) => {
      notifyTasksUpdated(tasksFileWatchCallbacks, workspaceId, content)
    },
    getWorkflowCliPolicy: () =>
      readWorkflowCliPolicy(settings.getAppState(WORKFLOW_CLI_POLICY_KEY)?.value ?? null),
    getFlags,
  })
  const uiAuth = createUiAuth()
  const remoteAuditStore = createRemoteAuditStore(db)
  // M4: the live runtime uses the PERSISTENT provider backed by the device store (M3's
  // InMemoryDeviceSessionProvider stays test-only). A device row exists only after a desktop confirm,
  // so this provider serves nothing until then; a revoke drops it from get()/candidates() at once.
  const remoteDeviceStore = createRemoteDeviceStore(db)
  const remoteDeviceSessions = createPersistentDeviceSessionProvider(remoteDeviceStore)
  const remotePairing = createRemotePairing({
    deviceStore: remoteDeviceStore,
    audit: remoteAuditStore,
    getGatewayUrl: () => settings.getAppState(REMOTE_GATEWAY_URL_KEY)?.value ?? null,
    getDaemonId: () => settings.getAppState(REMOTE_DAEMON_ID_KEY)?.value ?? null,
  })
  const shellRuntime = createWorkspaceShellRuntime(options.agentManager)

  agentRunStore.markUnfinishedRunsStale()
  workflowRunStore.markUnfinishedRunsInterrupted()

  const workspaceStore = createWorkspaceStore(db, dispatchLedgerStore.listOpenDispatchKinds)
  const workspaceUploadStore = createWorkspaceUploadStore(db, uploadStorage.uploadsDir)
  const teamMemoryExport = createTeamMemoryExportService({
    getWorkspacePath: (workspaceId) =>
      workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path,
    listDreamRuns: (workspaceId) =>
      teamMemoryDreamStore.listRuns(workspaceId, MEMORY_EXPORT_DREAM_CHANGELOG_LIMIT),
    listEntries: teamMemoryStore.listExportEntries,
  })
  const startExistingWorkspaceWatches = () => {
    for (const workspace of workspaceStore.listWorkspaces()) {
      void tasksFileWatcher
        .start(workspace.id, workspace.path)
        .catch((error) => logTasksFileWatchStartError(workspace.id, error))
    }
  }
  const restartPolicy = buildRuntimeRestartPolicy({
    listOpenDispatches: dispatchLedgerStore.listOpenWorkspaceDispatches,
    listDispatchMessagesForRecovery: dispatchMessageStore.listRecoveryMessages,
    listActionableDispatchMessagesForRecovery: dispatchMessageStore.listActionableWorkspaceMessages,
    agentRunStore,
    messageLogStore,
    memoryInjection,
    tasksFileService,
    workspaceStore,
    getFlags,
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
      // #81 follow-up: stop() leaves the old PTY draining (up to the
      // force-kill window) while startAgent has already spawned a replacement
      // run. The dying run's late onExit must not stop the agent, tear down
      // its output tracker, cancel its workflow dispatches, or cascade-dismiss
      // the orchestrator's workers — only an exit with no surviving live run
      // means the agent is gone.
      if (agentRuntime.getActiveRunByAgentId(workspaceId, agentId)) return
      workerOutputTracker?.detach(workspaceId, agentId)
      if (!workspaceStore.hasAgent(workspaceId, agentId)) return
      workspaceStore.markAgentStopped(workspaceId, agentId)
      // TIER 1 #1 — if the exiting worker had any open workflow dispatches,
      // tell the workflow awaiter so the runner's `awaitReport` rejects
      // immediately instead of hanging until DEFAULT_TIMEOUT_MS (10 min).
      // This is the only signal the runtime has that an ephemeral
      // workflow worker died without calling `team report`.
      const openWorkflowDispatches = dispatchLedgerStore.listOpenWorkflowDispatchesForWorker(
        workspaceId,
        agentId
      )
      for (const { dispatchId } of openWorkflowDispatches) {
        try {
          const cancelled = dispatchLedgerStore.markCancelled({
            dispatchId,
            reason: 'worker PTY exited before report',
            workspaceId,
          })
          if (!cancelled) continue
          try {
            workspaceStore.markTaskCancelled(workspaceId, agentId)
          } catch (error) {
            console.error('[hive] onAgentExit.markTaskCancelled failed', dispatchId, error)
          }
          workflowDispatchAwaiter.notifyCancel(dispatchId, 'worker PTY exited before report')
        } catch (error) {
          console.error('[hive] onAgentExit.markCancelled failed', dispatchId, error)
        }
      }
      // Cascade: when the orchestrator's PTY exits, dismiss the ephemeral
      // workers it spawned via `team spawn` (spec §6.3). Workflow-spawned
      // workers are owned by the runner, not the orchestrator.
      if (agentId === getOrchestratorId(workspaceId)) {
        const children = workspaceStore
          .getWorkspaceSnapshot(workspaceId)
          .agents.filter((agent) => agent.ephemeral === true && agent.spawnedBy === 'orchestrator')
        for (const child of children) removeWorkerCompletely(workspaceId, child.id)
      }
    },
    restartPolicy,
    (workspaceId, agentId) => workspaceStore.getAgent(workspaceId, agentId),
    getFlags,
    memoryInjection
  )
  const dispatchMessageOps = createDispatchMessageOperations({
    db,
    ledger: dispatchLedgerStore,
    messages: dispatchMessageStore,
    workspace: workspaceStore,
    runtime: agentRuntime,
    isClosing: () => closing,
  })
  const teamMemoryDreamRunner = createTeamMemoryDreamRunner({
    applyScheduledRun: teamMemoryDreamStore.applyAndCompleteRun,
    buildScheduledInput: (workspaceId, run) =>
      buildMemoryDreamInput({ teamMemoryDreamStore, teamMemoryStore }, workspaceId, run),
    dreamStore: teamMemoryDreamStore,
    deliverToOrchestrator: (workspaceId, text) =>
      agentRuntime.deliverSystemMessageToAgent(workspaceId, getOrchestratorId(workspaceId), text, {
        requireActiveRun: true,
      }),
    executeScheduledDream: ({ prompt, workspaceId }) =>
      teamMemoryDreamCli.execute({
        cwd: workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path,
        getCommandPreset: settings.getCommandPreset,
        orchestratorLaunchConfig: agentRuntime.peekAgentLaunchConfig(
          workspaceId,
          getOrchestratorId(workspaceId)
        ),
        prompt,
      }),
    scheduleExport: teamMemoryExport.schedule,
  })
  const teamMemoryDreamScheduler = createTeamMemoryDreamScheduler({
    getScheduleState: teamMemoryDreamStore.getScheduleState,
    getWorkspaceSnapshot: (workspaceId) => workspaceStore.getWorkspaceSnapshot(workspaceId),
    listWorkspaces: workspaceStore.listWorkspaces,
    runScheduled: teamMemoryDreamRunner.runScheduled,
    settings,
  })
  teamMemoryDreamScheduler.start()
  // Mirrors runtime-store.deleteWorker (drop dispatches + worker row
  // transactionally → drop launch config → stop run). Hoisted `function` so the
  // onAgentExit closure above can reference it; only invoked at runtime, after
  // agentRuntime is assigned.
  function removeWorkerCompletely(workspaceId: string, workerId: string) {
    const activeRun = agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
    const droppedNoticeTargets = new Set<string>()
    db.transaction(() => {
      for (const dispatch of dispatchLedgerStore.listOpenWorkspaceDispatches(workspaceId)) {
        if (
          dispatch.toAgentId === workerId &&
          dispatch.workflowRunId === null &&
          (dispatch.status === 'queued' || dispatch.status === 'submitted')
        ) {
          reportOutbox.deletePendingForDispatch(dispatch.id)
        }
      }
      // Open dispatch rows are about to be hard-deleted — queue issuer notices
      // in the same transaction or the delete must not commit.
      for (const targetAgentId of teamOps.notifyIssuersOfDroppedDispatches(
        workspaceId,
        workerId,
        'the worker was dismissed'
      )) {
        droppedNoticeTargets.add(targetAgentId)
      }
      dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
      workspaceStore.deleteWorker(workspaceId, workerId)
    })()
    for (const targetAgentId of droppedNoticeTargets) {
      teamOps.drainReportOutbox(workspaceId, targetAgentId)
    }
    agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
    if (activeRun) agentRuntime.stopAgentRun(activeRun.runId)
  }

  // Boot cleanup: after a runtime restart every ephemeral worker is an orphan
  // (its spawner — a workflow run or an orchestrator PTY — is gone). Remove
  // them so they don't accumulate (spec §6.3).
  const cleanupOrphanEphemeralWorkers = () => {
    const pendingWorktrees: Array<{ cwd: string; workspacePath: string }> = []
    for (const workspace of workspaceStore.listWorkspaces()) {
      const ephemeral = workspaceStore
        .getWorkspaceSnapshot(workspace.id)
        .agents.filter((agent) => agent.ephemeral === true)
      for (const agent of ephemeral) {
        const cwd = agentRuntime.peekAgentLaunchConfig(workspace.id, agent.id)?.cwd
        if (cwd) pendingWorktrees.push({ cwd, workspacePath: workspace.path })
        removeWorkerCompletely(workspace.id, agent.id)
      }
    }
    for (const item of pendingWorktrees) {
      void cleanupOrphanedWorkflowWorktree(item).catch((error) => {
        console.error('[hive] swallowed:orphanWorktree.cleanup', error)
      })
    }
  }
  const protocolEventStats = createProtocolEventStats(db)
  const teamOps = createTeamOperations({
    agentRuntime,
    createDispatch: dispatchLedgerStore.createDispatch,
    deleteDispatch: dispatchLedgerStore.deleteDispatch,
    deleteMessage: messageLogStore.deleteMessage,
    findOpenDispatch: dispatchLedgerStore.findOpenDispatch,
    findOpenDispatchById: dispatchLedgerStore.findOpenDispatchById,
    listOpenWorkspaceDispatches: dispatchLedgerStore.listOpenWorkspaceDispatches,
    insertMessage: messageLogStore.insertMessage,
    markDispatchCancelled: dispatchLedgerStore.markCancelled,
    markDispatchReportedByWorker: dispatchLedgerStore.markReportedByWorker,
    claimQueuedDispatch: dispatchLedgerStore.claimQueuedDispatch,
    reparkClaimedDispatch: dispatchLedgerStore.reparkClaimedDispatch,
    reportOutbox,
    notifyWebhook: webhookNotifier.notify,
    runDataMutation: (mutation) => db.transaction(mutation)(),
    isRuntimeClosing: () => closing,
    workflowDispatchAwaiter,
    workspaceStore,
    dismissEphemeralWorker: (workspaceId, workerId) =>
      removeWorkerCompletely(workspaceId, workerId),
    recordProtocolEvent: protocolEventStats.record,
    markDispatchDelivered: dispatchLedgerStore.markDelivered,
    recordReportPayloadBytes: dispatchLedgerStore.recordReportPayloadBytes,
    requiredSeenSeq: dispatchMessageStore.requiredSeenSeq,
    getFlags,
  })
  cleanupOrphanEphemeralWorkers()
  startExistingWorkspaceWatches()

  return {
    agentRunStore,
    agentRuntime,
    db,
    dispatchLedgerStore,
    dispatchMessageStore,
    dispatchMessageOps,
    externalGoalStore,
    isRuntimeClosing: () => closing,
    markRuntimeClosing: () => {
      closing = true
    },
    messageLogStore,
    remoteAuditStore,
    remoteDeviceSessions,
    remoteDeviceStore,
    remotePairing,
    settings,
    shellRuntime,
    tasksFileWatcher,
    tasksFileWatchCallbacks,
    tasksFileService,
    teamMemoryDreamRunner,
    teamMemoryDreamScheduler,
    protocolEventStats,
    reportOutbox,
    teamMemoryDreamStore,
    teamMemoryDiagnostics,
    teamMemoryExport,
    teamMemoryProvider,
    teamMemoryStore,
    teamRecallStore,
    teamOps,
    uiAuth,
    webhookNotifier,
    workerOutputTracker,
    workflowDispatchAwaiter,
    workflowRunLogStore,
    workflowRunStore,
    workflowScheduleStore,
    workspaceStore,
    workspaceUploadStore,
    workspaceUploadStorageCleanup: uploadStorage.cleanup,
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
    if (
      agentId === getOrchestratorId(workspaceId) &&
      services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.controller_mode ===
        'codex_app'
    )
      throw new ConflictError('This workspace uses Codex App as its controller')
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
        // #33: a freshly started worker may have dispatches parked from when
        // it was stopped — deliver them now (single-shot via claims; no-op
        // for orchestrator/workflow pseudo-agents, which never hold queued
        // worker dispatches addressed to themselves). Wait for post-start
        // guidance first so startup instructions never race the first task.
        const deliverPostStartBacklog = () => {
          if (services.isRuntimeClosing()) return
          try {
            services.teamOps.drainReportOutbox(workspaceId, agentId)
          } catch (error) {
            console.error('[hive] swallowed:startAgent.drainOutbox', error)
          }
          try {
            services.teamOps.replayQueuedDispatches(workspaceId, agentId, {
              createdBeforeMs: run.startedAt,
            })
            services.dispatchMessageOps.drainDispatchMessageOutbox(workspaceId, agentId)
          } catch (error) {
            console.error('[hive] swallowed:startAgent.replayQueued', error)
          }
        }
        if (run.postStartInputReady) {
          void run.postStartInputReady.then(deliverPostStartBacklog).catch((error) => {
            console.error('[hive] swallowed:startAgent.replayAfterPostStart', error)
          })
        } else {
          deliverPostStartBacklog()
        }
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
      if (workspace.controller_mode !== 'codex_app')
        seedOrchestratorLaunchConfig(services.agentRuntime, services.settings, workspace.id)
      return services.workspaceStore
        .getWorkspaceSnapshot(workspace.id)
        .agents.filter(
          (agent) =>
            !(
              workspace.controller_mode === 'codex_app' &&
              agent.id === getOrchestratorId(workspace.id)
            ) &&
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
  const findLiveRun = (runId: string): LiveAgentRun | undefined =>
    services.shellRuntime.getLiveRun(runId) ?? services.agentRuntime.findLiveRun(runId)

  return {
    close: async () => {
      services.markRuntimeClosing()
      try {
        // Fail in-flight workflow awaiters BEFORE their workers vanish, so the
        // runner's `await agent(...)` rejects with a clear shutdown error
        // instead of hanging on a Promise that can never resolve.
        await services.teamMemoryDreamScheduler.close()
        services.workflowDispatchAwaiter.cancelAll('runtime closing')
        // Shells do not use SQLite. Their exit failure must not bypass cleanup
        // of the independent agents/watchers that do; keep the database last.
        const [shellClose] = await Promise.allSettled([services.shellRuntime.close()])
        try {
          await services.teamMemoryExport.close()
          await services.agentRuntime.close()
          await services.tasksFileWatcher.close()
          services.workerOutputTracker?.closeAll()
          services.agentRunStore.close?.()
          services.db.close()
        } catch (error) {
          if (shellClose.status === 'rejected')
            throw new AggregateError([shellClose.reason, error], 'Runtime shutdown failed')
          throw error
        }
        if (shellClose.status === 'rejected') throw shellClose.reason
      } finally {
        services.workspaceUploadStorageCleanup()
      }
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
    findLiveRun,
    getLiveRun: (runId: string) => {
      const run = findLiveRun(runId)
      if (!run) throw new Error(`Live run not found: ${runId}`)
      return run
    },
    waitForRunExit: (runId: string, timeoutMs: number) =>
      services.agentRuntime.waitForRunExit(runId, timeoutMs),
    getPtyOutputBus: (): PtyOutputBus => {
      if (!agentManager) throw new Error('Agent manager is required for PTY output subscriptions')
      return agentManager.getOutputBus()
    },
    listTerminalRuns: (workspaceId: string) => [
      ...services.workspaceStore.getWorkspaceSnapshot(workspaceId).agents.flatMap((agent) => {
        const run = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (!run) return []
        const launchConfig = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agent.id)
        const interactiveCommand = launchConfig?.interactiveCommand ?? launchConfig?.command
        return [
          {
            agent_id: agent.id,
            agent_name: agent.name,
            has_user_input_since_start:
              agent.role === 'orchestrator'
                ? services.messageLogStore.hasUserInputSince(workspaceId, agent.id, run.startedAt)
                : null,
            run_id: run.runId,
            startup_blocked_reason:
              interactiveCommand &&
              isInteractiveAgentCommand(interactiveCommand) &&
              hasFirstRunSetupPrompt(run.output)
                ? ('first_run_setup' as const)
                : null,
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
