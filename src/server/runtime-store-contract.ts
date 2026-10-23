import type { IncomingMessage } from 'node:http'
import type { AgentSummary, TeamListItem, WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import type { DispatchMessageOperations } from './dispatch-message-operations.js'
import type {
  ExternalGoalBridge,
  ExternalGoalCancelInput,
  ExternalGoalContinueInput,
  ExternalGoalReportInput,
  ExternalGoalStartInput,
  ExternalGoalWaitInput,
} from './external-goal-bridge.js'
import type { RecoveryMessage } from './message-log-store.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import type { RemoteAuditStore } from './remote-audit-store.js'
import type { DeviceSessionProvider } from './remote-device-session.js'
import type { RemoteDeviceRecord, RemoteDeviceStore } from './remote-device-store.js'
import type { RemotePairing } from './remote-pairing.js'
import type { RemoteTunnel, TunnelStatus } from './remote-tunnel.js'
import type { ControllerMethods } from './runtime-store-controller.js'
import type { MemoryDreamInput } from './runtime-store-dream.js'
import type { SettingsStore } from './settings-store.js'
import type { BuildMemoryDiagnosticsInput, MemoryDiagnostics } from './team-memory-diagnostics.js'
import type { DreamRunRecord } from './team-memory-dream-store.js'
import type {
  AddMemoryEntryInput,
  LogMemoryInjectionsInput,
  MemoryEntryWithSources,
  MemoryInjectionWithMemory,
  MemoryListOptions,
  MemorySearchOptions,
  MemorySearchResult,
} from './team-memory-store.js'
import type {
  CancelTaskInput,
  DispatchTaskInput,
  ReportTaskInput,
  ReportTaskResult,
  StatusTaskInput,
} from './team-operations.js'
import type { RecallOptions, RecallResult } from './team-recall-store.js'
import type { TerminalRunSummary } from './terminal-input-profile.js'
import type { WorkflowDispatchAwaiter } from './workflow-dispatch-awaiter.js'
import type { WorkflowRunRecord } from './workflow-run-store.js'
import type { RunInlineWorkflowInput, RunWorkflowInput, WorkflowRunner } from './workflow-runner.js'
import type { WorkflowScheduleRecord } from './workflow-schedule-store.js'
import type { WorkerInput, WorkspaceRecord } from './workspace-store.js'
import type { SaveWorkspaceUploadInput, WorkspaceUploadRecord } from './workspace-upload-store.js'

export interface RuntimeStore extends DispatchMessageOperations, ControllerMethods {
  close: () => Promise<void>
  createWorkspace: (
    path: string,
    name: string,
    controllerMode?: 'internal' | 'codex_app'
  ) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => Promise<void>
  listWorkspaces: () => WorkspaceSummary[]
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  addWorkerWithLaunch: (
    workspaceId: string,
    input: WorkerInput,
    launchConfig: AgentLaunchConfigInput
  ) => AgentSummary
  deleteWorker: (workspaceId: string, workerId: string) => void
  updateWorkerProfile: (
    workspaceId: string,
    workerId: string,
    input: { avatar?: string | null; name?: string }
  ) => AgentSummary
  updateWorkerAvatar: (workspaceId: string, workerId: string, avatar: string | null) => AgentSummary
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentSummary
  recordUserInput: (workspaceId: string, orchestratorId: string, text: string) => void
  deliverUserInput: (workspaceId: string, orchestratorId: string, text: string) => Promise<void>
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
  ) => Promise<DispatchRecord & { restartedWorker: boolean; queuedForStoppedWorker?: boolean }>
  reportTask: (workspaceId: string, workerId: string, input?: ReportTaskInput) => ReportTaskResult
  /** Flush any reports stranded by a prior orchestrator outage. Safe no-op
   *  when the orchestrator is down or the outbox is empty. */
  drainReportOutbox: (workspaceId: string, targetAgentId?: string) => void
  statusTask: (workspaceId: string, workerId: string, input?: StatusTaskInput) => ReportTaskResult
  cancelTask: (
    workspaceId: string,
    dispatchId: string,
    input: CancelTaskInput
  ) => Promise<ReportTaskResult>
  listDispatches: (workspaceId: string, options?: ListDispatchesOptions) => DispatchRecord[]
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  listOpenDispatches: (workspaceId: string) => DispatchRecord[]
  listRecentDispatches: (workspaceId: string, limit?: number) => DispatchRecord[]
  listExternalGoalWorkspaces: ExternalGoalBridge['listWorkspaces']
  inspectExternalGoalWorkspace: ExternalGoalBridge['inspectWorkspace']
  startExternalGoal: (input: ExternalGoalStartInput) => ReturnType<ExternalGoalBridge['startGoal']>
  continueExternalGoal: (
    input: ExternalGoalContinueInput
  ) => ReturnType<ExternalGoalBridge['continueGoal']>
  reportExternalGoal: (
    input: ExternalGoalReportInput
  ) => ReturnType<ExternalGoalBridge['reportGoal']>
  waitExternalGoal: (input: ExternalGoalWaitInput) => ReturnType<ExternalGoalBridge['waitGoal']>
  cancelExternalGoal: (
    input: ExternalGoalCancelInput
  ) => ReturnType<ExternalGoalBridge['cancelGoal']>
  listWorkers: (workspaceId: string) => TeamListItem[]
  getLastPtyLineForAgent: (workspaceId: string, agentId: string) => string | null
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getPtyOutputBus: () => PtyOutputBus
  listTerminalRuns: (workspaceId: string) => TerminalRunSummary[]
  closeWorkspaceShell: (workspaceId: string, runId: string) => boolean
  startWorkspaceShell: (workspaceId: string) => Promise<LiveAgentRun>
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
  findLiveRun: (runId: string) => LiveAgentRun | undefined
  getLiveRun: (runId: string) => LiveAgentRun
  waitForRunExit: (runId: string, timeoutMs: number) => Promise<boolean>
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  registerTasksListener: (listener: (workspaceId: string, content: string) => void) => () => void
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  recallMessages: (workspaceId: string, query: string, options?: RecallOptions) => RecallResult[]
  addMemoryEntry: (input: AddMemoryEntryInput) => MemoryEntryWithSources
  approveMemoryCandidate: (workspaceId: string, memoryId: string) => MemoryEntryWithSources
  archiveMemoryEntry: (workspaceId: string, memoryId: string) => MemoryEntryWithSources
  getMemoryEntry: (workspaceId: string, memoryId: string) => MemoryEntryWithSources | undefined
  getMemoryDiagnostics: (input: BuildMemoryDiagnosticsInput) => MemoryDiagnostics
  listMemoryEntries: (workspaceId: string, options?: MemoryListOptions) => MemoryEntryWithSources[]
  listMemoryInjectionsForDispatch: (
    workspaceId: string,
    dispatchId: string
  ) => MemoryInjectionWithMemory[]
  logMemoryInjections: (input: LogMemoryInjectionsInput) => string[]
  rejectMemoryCandidate: (workspaceId: string, memoryId: string) => MemoryEntryWithSources
  searchMemoryEntries: (
    workspaceId: string,
    query: string,
    options?: MemorySearchOptions
  ) => MemorySearchResult[]
  setMemoryDisabled: (
    workspaceId: string,
    memoryId: string,
    disabled: boolean
  ) => MemoryEntryWithSources
  setMemoryPinned: (
    workspaceId: string,
    memoryId: string,
    pinned: boolean
  ) => MemoryEntryWithSources
  applyMemoryDreamRun: (workspaceId: string, runId: string, rawOps: unknown) => DreamRunRecord
  getMemoryDreamInput: (workspaceId: string, runId: string) => MemoryDreamInput
  listMemoryDreamRuns: (workspaceId: string, limit?: number) => DreamRunRecord[]
  revertMemoryDream: (workspaceId: string, runId: string) => DreamRunRecord
  runMemoryDream: (workspaceId: string) => Promise<DreamRunRecord>
  tickMemoryDreamScheduler: (now?: number) => Promise<void>
  peekAgentToken: (agentId: string) => string | undefined
  pauseTerminalRun: (runId: string) => void
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeTerminalRun: (runId: string) => void
  settings: SettingsStore
  writeRunInput: (runId: string, input: Buffer | string) => void
  getUiToken: () => string
  getSupervisorToken: () => string
  stopAgentRun: (runId: string) => void
  validateAgentToken: (agentId: string, token: string | undefined) => boolean
  validateUiToken: (token: string | undefined) => boolean
  validateSupervisorToken: (token: string | undefined) => boolean
  // Remote tunnel (invariant 2): true iff the request carries the live per-boot
  // tunnel secret. The auth chokepoints pass this as the optional authorize-arg
  // so tunnel-originated loopback requests skip the cookie check.
  authorizeRemoteTunnelRequest: (request: IncomingMessage) => boolean
  // The live per-boot secret — handed only to the in-process tunnel so it can
  // stamp loopback request headers. Never persisted, never logged.
  getRemoteTunnelSecret: () => string
  // The remote tunnel's single audit sink (HTTP / WS / lifecycle / reject rows).
  getRemoteAuditStore: () => RemoteAuditStore
  // The M3 device-session seam — now the PERSISTENT pairing-backed provider (M4). The mount hands
  // this to createRemoteTunnel so the bridge can resolve a confirmed device's keys; a revoke makes
  // the next get() return null at once (invariant 5).
  getRemoteDeviceSessions: () => DeviceSessionProvider
  // The daemon pairing engine (M4 trust root). beginPairing/etc. — confirmPairing is the ONLY caller
  // that persists a device, and the routes only reach it from the desktop-only gate. The CONFIRM path
  // goes through confirmRemotePairing below (it must also register the device with the gateway + tell
  // the phone over the tunnel), so routes do NOT call getRemotePairing().confirmPairing directly.
  getRemotePairing: () => RemotePairing
  // Desktop-confirm a pairing (trust root, plan step 4 / D3). Delegates to the bound tunnel's driver:
  // local row insert -> POST /pair/confirm (gateway device row) -> `confirmed` to the phone, in that
  // order. Rejects if the gateway POST fails or the boundJti is missing (the phone is NOT told OK).
  // Returns null for an unknown/expired/wrong-state pairing. When no tunnel is bound (tunnel-less
  // runtime), falls back to the engine's local-only confirm so the trust-root write still happens.
  confirmRemotePairing: (pairingId: string, name?: string) => Promise<RemoteDeviceRecord | null>
  // The paired-device metadata/key store (M4). Routes only touch the METADATA path (list/get); the
  // key material flows internally through the provider, never out of a route.
  getRemoteDeviceStore: () => RemoteDeviceStore
  // Last tunnel status seen via onStatus (default 'disabled'). Backs GET /api/remote/status.connected.
  getRemoteTunnelStatus: () => TunnelStatus
  /** Local retention signals (issue #23): per-day protocol event counts. Local-only, never transmitted. */
  getRetentionSignals: () => import('./protocol-event-stats.js').RetentionSignals
  /** Local per-dispatch collaboration cost (issue #75). Local-only, never transmitted. */
  getCollaborationMetrics: (
    workspaceId: string,
    windowDays?: number
  ) => import('../shared/types.js').CollaborationMetrics
  // Record the latest tunnel status (fed by hive.ts's onStatus). Internal setter for the above.
  setRemoteTunnelStatus: (status: TunnelStatus) => void
  // Bind the live tunnel so revokeRemoteDevice can close a device's streams. Called once in hive.ts
  // after the tunnel is constructed; before binding (or in a tunnel-less runtime) closeDevice no-ops.
  bindRemoteTunnel: (tunnel: RemoteTunnel) => void
  // Flip the remote_enabled flag (default OFF) and reconcile the tunnel. The conditional desktop-only
  // gate (a remote may turn OFF but never ON) lives at the route layer, not here.
  setRemoteEnabled: (enabled: boolean) => void
  // Revocation closed loop (invariant 5): (1) deviceStore.revoke -> provider drops the session so the
  // next inbound frame fails no_session; (2) tunnel.closeDevice tears the device's live streams now;
  // (3) audit a revoke row. Step 1 is the security-load-bearing half; step 2 is best-effort liveness.
  revokeRemoteDevice: (deviceId: string) => boolean
  getWorkflowDispatchAwaiter: () => WorkflowDispatchAwaiter
  runWorkflow: (input: RunWorkflowInput) => Promise<WorkflowRunRecord>
  startWorkflow: (input: RunWorkflowInput) => Promise<WorkflowRunRecord>
  startWorkflowInline: (input: RunInlineWorkflowInput) => Promise<WorkflowRunRecord>
  stopWorkflowRun: (runId: string) => boolean
  getWorkflowRun: (runId: string) => WorkflowRunRecord | undefined
  listWorkspaceWorkflowRuns: (workspaceId: string) => WorkflowRunRecord[]
  listWorkflowRunDispatches: (runId: string) => DispatchRecord[]
  listWorkflowRunLogs: (runId: string) => Array<{ id: number; ts: number; message: string }>
  saveWorkspaceUpload: (input: SaveWorkspaceUploadInput) => Promise<WorkspaceUploadRecord>
  listWorkspaceUploads: (workspaceId: string, limit?: number) => WorkspaceUploadRecord[]
  readWorkspaceUpload: (
    workspaceId: string,
    uploadId: string
  ) => Promise<{ data: Buffer; record: WorkspaceUploadRecord } | undefined>
  createWorkflowSchedule: (input: {
    workspaceId: string
    scriptPath: string
    cron: string
    nextRunAt: number
    args?: unknown
    enabled?: boolean
  }) => WorkflowScheduleRecord
  scheduleWorkflowInline: (input: {
    workspaceId: string
    source: string
    name: string
    cron: string
    nextRunAt: number
    args?: unknown
  }) => Promise<WorkflowScheduleRecord>
  updateWorkflowSchedule: (
    id: string,
    input: {
      cron?: string
      args?: unknown
      enabled?: boolean
      lastRunAt?: number
      nextRunAt?: number
    }
  ) => void
  getWorkflowSchedule: (id: string) => WorkflowScheduleRecord | undefined
  listWorkspaceWorkflowSchedules: (workspaceId: string) => WorkflowScheduleRecord[]
  deleteWorkflowSchedule: (id: string) => void
}

export interface RuntimeStoreOptions {
  dataDir?: string
  agentManager?: AgentManager
}

export interface StartAgentOptions {
  hivePort: string
}

export type RuntimeWorkflowRuntime = {
  runner: WorkflowRunner
  scheduler: { close: () => void; start: () => void }
}
