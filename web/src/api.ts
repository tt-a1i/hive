import type {
  ActionCenterConversation,
  ActionCenterMessage,
} from '../../src/shared/action-center.js'
import type { OpenTargetId, OpenWorkspaceErrorCode } from '../../src/shared/open-targets.js'
import type {
  MemoryKind,
  MemoryProcedureRef,
  MemoryProcedureRefType,
  MemoryScope,
} from '../../src/shared/team-memory.js'
import type {
  AgentSummary,
  ControllerStatus,
  TeamListItem,
  TeamListItemPayload,
  WorkerRole,
  WorkspaceSummary,
} from '../../src/shared/types.js'
import type { UiLanguage } from '../../src/shared/ui-language.js'

import type { ApiTransport } from './transport/api-transport.js'
import { directTransport } from './transport/direct-transport.js'

export type { OpenTargetId, OpenWorkspaceErrorCode }

// The seam every /api/* call rides. DirectTransport (desktop) is the default and never imports the
// tunnel code; M5b's mobile entry swaps in createTunnelTransport before the React app mounts.
let activeTransport: ApiTransport = directTransport
export const setApiTransport = (t: ApiTransport): void => {
  activeTransport = t
}
export const getApiTransport = (): ApiTransport => activeTransport

const activeTransportRequiresUiSession = (): boolean => activeTransport.requiresUiSession !== false

const fromPayload = (payload: TeamListItemPayload): TeamListItem => ({
  id: payload.id,
  name: payload.name,
  role: payload.role,
  status: payload.status,
  pendingTaskCount: payload.pending_task_count,
  ...(payload.avatar ? { avatar: payload.avatar } : {}),
  ...(payload.last_pty_line ? { lastPtyLine: payload.last_pty_line } : {}),
  ...(payload.command_preset_id ? { commandPresetId: payload.command_preset_id } : {}),
  ...(payload.startup_ready_at != null ? { startupReadyAt: payload.startup_ready_at } : {}),
  ...(payload.ephemeral === true ? { ephemeral: true as const } : {}),
  ...(payload.spawned_by ? { spawnedBy: payload.spawned_by } : {}),
})

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // Keep the original fallback when the server did not send a JSON error body.
  }
  return fallback
}

const isStaleUiSession = async (response: Response): Promise<boolean> => {
  if (response.status !== 403) return false
  try {
    const body = (await response.clone().json()) as { error?: unknown }
    return body.error === 'UI endpoint requires valid UI token'
  } catch {
    return false
  }
}

export const initializeUiSession = async (): Promise<void> => {
  if (!activeTransportRequiresUiSession()) return

  const response = await activeTransport.fetch('/api/ui/session', { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error('Failed to initialize UI session')
  }
  await response.json()
}

let uiSessionRefreshPromise: Promise<void> | null = null

const refreshUiSession = (): Promise<void> => {
  uiSessionRefreshPromise ??= initializeUiSession().finally(() => {
    uiSessionRefreshPromise = null
  })
  return uiSessionRefreshPromise
}

const apiFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const response = await activeTransport.fetch(input, init)
  if (!activeTransportRequiresUiSession() || !(await isStaleUiSession(response))) return response

  await refreshUiSession()
  return activeTransport.fetch(input, init)
}

export const listWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await apiFetch('/api/workspaces')

  if (!response.ok) {
    throw new Error('Failed to load workspaces')
  }

  return (await response.json()) as WorkspaceSummary[]
}

export interface VersionInfo {
  canRunHiveUpdate: boolean
  currentVersion: string
  installHint: string
  installSource: string
  latestVersion: string
  packageName: string
  releaseUrl: string
  updateNote: string
  updateAvailable: boolean
}

interface VersionInfoPayload {
  can_run_hive_update?: boolean
  current_version: string
  install_hint: string
  install_source?: string
  latest_version: string
  package_name: string
  release_url: string
  update_note?: string
  update_available: boolean
}

export const getVersionInfo = async (): Promise<VersionInfo> => {
  const response = await apiFetch('/api/version')

  if (!response.ok) {
    throw new Error('Failed to load version info')
  }

  const payload = (await response.json()) as VersionInfoPayload
  return {
    canRunHiveUpdate: payload.can_run_hive_update ?? payload.install_hint === 'hive update',
    currentVersion: payload.current_version,
    installHint: payload.install_hint,
    installSource: payload.install_source ?? 'unknown',
    latestVersion: payload.latest_version,
    packageName: payload.package_name,
    releaseUrl: payload.release_url,
    updateNote: payload.update_note ?? '',
    updateAvailable: payload.update_available,
  }
}

export interface OrchestratorStartResult {
  ok: boolean
  error: string | null
  run_id: string | null
}

export interface CommandPreset {
  args: string[]
  available: boolean
  command: string
  displayName: string
  id: string
}

export interface RoleTemplate {
  description: string
  id: string
  isBuiltin: boolean
  name: string
  roleType: WorkerRole | 'orchestrator'
}

export interface RoleTemplateInput {
  description: string
  name: string
  roleType: WorkerRole | 'orchestrator'
}

interface CommandPresetPayload {
  args: string[]
  available: boolean
  command: string
  display_name: string
  id: string
}

interface RoleTemplatePayload {
  description: string
  id: string
  is_builtin: boolean
  name: string
  role_type: WorkerRole | 'orchestrator'
}

const fromRoleTemplatePayload = (payload: RoleTemplatePayload): RoleTemplate => ({
  description: payload.description,
  id: payload.id,
  isBuiltin: payload.is_builtin,
  name: payload.name,
  roleType: payload.role_type,
})

const toRoleTemplateBody = (input: RoleTemplateInput) => ({
  name: input.name,
  role_type: input.roleType,
  description: input.description,
  default_command: '',
  default_args: [],
  default_env: {},
})

export interface AgentStartResult {
  error: string | null
  ok: boolean
  runId: string | null
}

interface AgentStartPayload {
  error: string | null
  ok: boolean
  run_id: string | null
}

export interface CreateWorkerResult {
  agentStart: AgentStartResult
  worker: TeamListItem
}

type CreateWorkerPayload = TeamListItemPayload & { agent_start?: AgentStartPayload }

export interface CreateWorkspaceResponse extends WorkspaceSummary {
  orchestrator_start: OrchestratorStartResult
}

export const createWorkspace = async (input: {
  name: string
  path: string
  controller_mode?: 'internal' | 'codex_app'
  autostart_orchestrator?: boolean
  command_preset_id?: string | null
  startup_command?: string | null
  ui_language?: UiLanguage
}): Promise<CreateWorkspaceResponse> => {
  const response = await apiFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create workspace'))
  }

  return (await response.json()) as CreateWorkspaceResponse
}

export const deleteWorkspace = async (workspaceId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}`, { method: 'DELETE' })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete workspace'))
  }
}

export const startAgentRun = async (
  workspaceId: string,
  agentId: string
): Promise<{ runId: string }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/agents/${agentId}/start`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start agent run'))
  }
  const body = (await response.json()) as { run_id: string }
  return { runId: body.run_id }
}

export const stopAgentRun = async (runId: string): Promise<void> => {
  const response = await apiFetch(`/api/runtime/runs/${runId}/stop`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error('Failed to stop agent run')
  }
}

export class RuntimeRunProbeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'RuntimeRunProbeError'
  }
}

export const isRuntimeRunActive = async (runId: string): Promise<boolean> => {
  const response = await apiFetch(`/api/runtime/runs/${encodeURIComponent(runId)}`, {
    mode: 'same-origin',
  })
  if (response.status === 404) return false
  if (!response.ok) {
    throw new RuntimeRunProbeError(
      response.status,
      await readErrorMessage(response, 'Failed to load agent run')
    )
  }
  const run = (await response.json()) as { status?: unknown }
  return run.status === 'starting' || run.status === 'running'
}

export const sendWorkspaceUserInput = async (workspaceId: string, text: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/user-input`, {
    body: JSON.stringify({ text }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to send goal to Orchestrator'))
  }
}

export const restartAgentRun = async (
  workspaceId: string,
  agentId: string,
  runId: string
): Promise<{ runId: string }> => {
  // Best-effort stop: a 404 here often means the run already exited on its
  // own; either way we proceed to start a fresh one. Swallowed errors land in
  // the dev console for diagnosis.
  await stopAgentRun(runId).catch((error: unknown) => {
    console.error('[hive] swallowed:restartAgentRun.stop', error)
  })
  return startAgentRun(workspaceId, agentId)
}

export const getActiveWorkspaceId = async (): Promise<string | null> => {
  const response = await apiFetch('/api/settings/app-state/active_workspace_id')

  if (!response.ok) {
    throw new Error('Failed to load active workspace')
  }

  const payload = (await response.json()) as { key: string; value: string | null }
  return payload.value
}

export const saveActiveWorkspaceId = async (workspaceId: string | null): Promise<void> => {
  const response = await apiFetch('/api/settings/app-state/active_workspace_id', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: workspaceId }),
  })

  if (!response.ok) {
    throw new Error('Failed to save active workspace')
  }
}

const WEBHOOK_URL_STATE_KEY = 'notifications.webhook-url'

export const getWebhookUrl = async (): Promise<string> => {
  const response = await apiFetch(`/api/settings/app-state/${WEBHOOK_URL_STATE_KEY}`)
  if (!response.ok) throw new Error('Failed to load webhook URL')
  const payload = (await response.json()) as { key: string; value: string | null }
  return payload.value ?? ''
}

export const saveWebhookUrl = async (url: string): Promise<void> => {
  const response = await apiFetch(`/api/settings/app-state/${WEBHOOK_URL_STATE_KEY}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: url.trim() }),
  })
  if (!response.ok) throw new Error('Failed to save webhook URL')
}

export interface WorkflowCliPolicy {
  default: string
  allowed: string[]
}

export interface WorkflowCliPolicyResponse extends WorkflowCliPolicy {
  /** Every CLI the runtime can launch — the UI offers a subset of these. */
  supported: string[]
}

export const getWorkflowCliPolicy = async (): Promise<WorkflowCliPolicyResponse> => {
  const response = await apiFetch('/api/settings/workflow-cli-policy')
  if (!response.ok) {
    throw new Error('Failed to load workflow CLI policy')
  }
  return (await response.json()) as WorkflowCliPolicyResponse
}

export const saveWorkflowCliPolicy = async (
  policy: WorkflowCliPolicy
): Promise<WorkflowCliPolicyResponse> => {
  const response = await apiFetch('/api/settings/workflow-cli-policy', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(policy),
  })
  if (!response.ok) {
    throw new Error('Failed to save workflow CLI policy')
  }
  return (await response.json()) as WorkflowCliPolicyResponse
}

export const getWorkflowFeature = async (): Promise<{ enabled: boolean }> => {
  const response = await apiFetch('/api/settings/workflow-feature')
  if (!response.ok) {
    throw new Error('Failed to load workflow feature flag')
  }
  return (await response.json()) as { enabled: boolean }
}

export const setWorkflowFeature = async (enabled: boolean): Promise<{ enabled: boolean }> => {
  const response = await apiFetch('/api/settings/workflow-feature', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!response.ok) {
    throw new Error('Failed to save workflow feature flag')
  }
  return (await response.json()) as { enabled: boolean }
}

export const listWorkers = async (workspaceId: string): Promise<TeamListItem[]> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/team`, {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load workers')
  }

  const payload = (await response.json()) as TeamListItemPayload[]
  return payload.map(fromPayload)
}

export const listCommandPresets = async (): Promise<CommandPreset[]> => {
  const response = await apiFetch('/api/settings/command-presets')

  if (!response.ok) {
    throw new Error('Failed to load command presets')
  }

  return ((await response.json()) as CommandPresetPayload[]).map((preset) => ({
    args: preset.args,
    available: preset.available,
    command: preset.command,
    displayName: preset.display_name,
    id: preset.id,
  }))
}

export type TerminalInputProfile = 'codex' | 'default' | 'grok' | 'opencode'

export interface TerminalRunSummary {
  agent_id: string
  agent_name: string
  has_user_input_since_start?: boolean | null
  run_id: string
  startup_blocked_reason?: 'first_run_setup' | null
  status: string
  terminal_input_profile?: TerminalInputProfile
}

export const workspaceShellAgentId = (workspaceId: string): string => `${workspaceId}:shell`

export const isWorkspaceShellRun = (run: TerminalRunSummary, workspaceId: string): boolean =>
  run.agent_id === workspaceShellAgentId(workspaceId)

export const startWorkspaceShell = async (workspaceId: string): Promise<TerminalRunSummary> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/shell/start`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start workspace terminal'))
  }

  return (await response.json()) as TerminalRunSummary
}

export const closeWorkspaceShell = async (workspaceId: string, runId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/shell/${runId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to close workspace terminal'))
  }
}

export const listRoleTemplates = async (): Promise<RoleTemplate[]> => {
  const response = await apiFetch('/api/settings/role-templates', {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load role templates')
  }

  const payload = (await response.json()) as RoleTemplatePayload[]
  return payload.map(fromRoleTemplatePayload)
}

export const createRoleTemplate = async (input: RoleTemplateInput): Promise<RoleTemplate> => {
  const response = await apiFetch('/api/settings/role-templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toRoleTemplateBody(input)),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create role template'))
  }

  return fromRoleTemplatePayload((await response.json()) as RoleTemplatePayload)
}

export const updateRoleTemplate = async (
  templateId: string,
  input: RoleTemplateInput
): Promise<RoleTemplate> => {
  const response = await apiFetch(`/api/settings/role-templates/${templateId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toRoleTemplateBody(input)),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update role template'))
  }

  return fromRoleTemplatePayload((await response.json()) as RoleTemplatePayload)
}

export const deleteRoleTemplate = async (templateId: string): Promise<void> => {
  const response = await apiFetch(`/api/settings/role-templates/${templateId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete role template'))
  }
}

export type MarketplaceLanguage = 'en' | 'zh'

export interface MarketplaceAgentEntry {
  path: string
  category: string
  name: string
  displayName?: string
  nameOverflows?: boolean
  description: string
  emoji: string | null
  color: string | null
  vibe: string | null
}

export interface MarketplaceManifest {
  source: {
    repo: string
    commit: string
    fetched_at: string
  }
  language: MarketplaceLanguage
  categories: string[]
  agents: MarketplaceAgentEntry[]
}

export interface MarketplaceAgentDetail {
  path: string
  frontmatter: Record<string, unknown>
  body: string
}

export const fetchMarketplaceManifest = async (
  lang: MarketplaceLanguage
): Promise<MarketplaceManifest> => {
  const response = await apiFetch(`/api/marketplace/manifest?lang=${lang}`, {
    mode: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load marketplace manifest'))
  }
  return (await response.json()) as MarketplaceManifest
}

export const fetchMarketplaceAgent = async (
  lang: MarketplaceLanguage,
  path: string
): Promise<MarketplaceAgentDetail> => {
  const response = await apiFetch(
    `/api/marketplace/agent?lang=${lang}&path=${encodeURIComponent(path)}`,
    { mode: 'same-origin' }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load marketplace agent'))
  }
  return (await response.json()) as MarketplaceAgentDetail
}

export const listTerminalRuns = async (workspaceId: string): Promise<TerminalRunSummary[]> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/runs`, {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load terminal runs')
  }

  return (await response.json()) as TerminalRunSummary[]
}

export const createWorker = async (
  workspaceId: string,
  input: Pick<AgentSummary, 'name'> & {
    autostart?: boolean
    avatar?: string | null
    command_preset_id?: string | null
    description?: string
    role: WorkerRole
    startup_command?: string | null
    ui_language?: UiLanguage
  }
): Promise<CreateWorkerResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create worker'))
  }

  const payload = (await response.json()) as CreateWorkerPayload
  return {
    agentStart: {
      error: payload.agent_start?.error ?? null,
      ok: payload.agent_start?.ok ?? false,
      runId: payload.agent_start?.run_id ?? null,
    },
    worker: fromPayload(payload),
  }
}

export interface ScenarioAppliedWorker {
  id: string
  name: string
  role: WorkerRole
  start?: {
    ok: true
    run_id: string
  }
}

export const applyScenarioTeam = async (
  workspaceId: string,
  scenarioId: string,
  goal: string,
  locale: UiLanguage
): Promise<{ createdWorkers: ScenarioAppliedWorker[] }> => {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/scenarios/${encodeURIComponent(scenarioId)}/apply`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal, locale }),
    }
  )

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to assemble the scenario team'))
  }

  const payload = (await response.json()) as { created_workers: ScenarioAppliedWorker[] }
  return { createdWorkers: payload.created_workers }
}

export const deleteWorker = async (workspaceId: string, workerId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete worker'))
  }
}

export const renameWorker = async (
  workspaceId: string,
  workerId: string,
  name: string
): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    body: JSON.stringify({ name }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to rename worker'))
  }
}

export const updateWorkerAvatar = async (
  workspaceId: string,
  workerId: string,
  avatar: string | null
): Promise<TeamListItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    body: JSON.stringify({ avatar }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update worker avatar'))
  }

  return fromPayload((await response.json()) as TeamListItemPayload)
}

export const getWorkspaceTasks = async (workspaceId: string): Promise<{ content: string }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks`)

  if (!response.ok) {
    throw new Error('Failed to load tasks')
  }

  return (await response.json()) as { content: string }
}

export const saveWorkspaceTasks = async (
  workspaceId: string,
  input: { content: string }
): Promise<{ content: string }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error('Failed to save tasks')
  }

  return (await response.json()) as { content: string }
}

export interface FsBrowseEntryPayload {
  is_dir: true
  is_git_repository: boolean
  name: string
  path: string
}

export interface FsBrowseResponse {
  current_path: string
  entries: FsBrowseEntryPayload[]
  error: string | null
  ok: boolean
  parent_path: string | null
  root_path: string
}

export interface FsProbeResponse {
  current_branch: string | null
  exists: boolean
  is_dir: boolean
  is_git_repository: boolean
  ok: boolean
  path: string
  suggested_name: string
}

export const browseFs = async (path: string): Promise<FsBrowseResponse> => {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const response = await apiFetch(`/api/fs/browse${query}`, { mode: 'same-origin' })
  const body = (await response.json()) as FsBrowseResponse
  return body
}

export const probeFs = async (path: string): Promise<FsProbeResponse> => {
  const response = await apiFetch(`/api/fs/probe?path=${encodeURIComponent(path)}`, {
    mode: 'same-origin',
  })
  return (await response.json()) as FsProbeResponse
}

export interface PickFolderResponse {
  canceled: boolean
  error: string | null
  path: string | null
  probe: FsProbeResponse | null
  supported: boolean
}

export const pickFolder = async (): Promise<PickFolderResponse> => {
  const response = await apiFetch('/api/fs/pick-folder', {
    method: 'POST',
    mode: 'same-origin',
  })
  return (await response.json()) as PickFolderResponse
}

export type OpenWorkspaceResult =
  | { ok: true; effectiveTargetId: OpenTargetId }
  | { ok: false; effectiveTargetId: OpenTargetId; errorCode: OpenWorkspaceErrorCode }

interface OpenWorkspaceSuccessPayload {
  ok: true
  effective_target_id: OpenTargetId
}

interface OpenWorkspaceFailurePayload {
  ok: false
  effective_target_id: OpenTargetId
  error_code: OpenWorkspaceErrorCode
}

export const openWorkspaceInEditor = async (
  workspaceId: string,
  targetId: OpenTargetId
): Promise<OpenWorkspaceResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/open`, {
    body: JSON.stringify({ target_id: targetId }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  // 200 success and 502 service failure both return structured JSON we can
  // surface; only true transport / 4xx failures (workspace gone, target id
  // tampered) throw.
  if (response.status === 200) {
    const body = (await response.json()) as OpenWorkspaceSuccessPayload
    return { ok: true, effectiveTargetId: body.effective_target_id }
  }
  if (response.status === 502) {
    const body = (await response.json()) as OpenWorkspaceFailurePayload
    return {
      ok: false,
      effectiveTargetId: body.effective_target_id,
      errorCode: body.error_code,
    }
  }
  throw new Error(await readErrorMessage(response, 'Failed to open workspace'))
}

// ----- Workspace memory -----------------------------------------------------

export type MemoryStatus = 'active' | 'candidate' | 'archived' | 'rejected'
export type MemorySource = 'manual' | 'dream'
export type MemorySourceType = 'manual' | 'message' | 'dispatch' | 'report' | 'dream' | 'memory'

export interface MemorySourceRecord {
  actorAgentIdSnapshot: string | null
  actorNameSnapshot: string | null
  actorRoleSnapshot: string | null
  createdAt: number
  excerpt: string | null
  id: string
  memoryId: string
  sourceId: string | null
  sourceSequence: number | null
  sourceType: MemorySourceType
  textHash: string | null
}

export interface MemoryEntry {
  archivedAt: number | null
  body: string
  confidence: number | null
  createdAt: number
  disabled: boolean
  id: string
  kind: MemoryKind
  lastInjectedAt: number | null
  pinned: boolean
  procedureRef: MemoryProcedureRef | null
  scope: MemoryScope
  source: MemorySource
  sources: MemorySourceRecord[]
  status: MemoryStatus
  tags: string[]
  updatedAt: number
  workspaceId: string | null
}

interface MemorySourcePayload {
  actor_agent_id_snapshot: string | null
  actor_name_snapshot: string | null
  actor_role_snapshot: string | null
  created_at: number
  excerpt: string | null
  id: string
  memory_id: string
  source_id: string | null
  source_sequence: number | null
  source_type: MemorySourceType
  text_hash: string | null
}

interface MemoryEntryPayload {
  archived_at: number | null
  body: string
  confidence: number | null
  created_at: number
  disabled: boolean
  id: string
  kind: MemoryKind
  last_injected_at: number | null
  pinned: boolean
  procedure_ref: MemoryProcedureRefPayload | null
  scope: MemoryScope
  source: MemorySource
  sources: MemorySourcePayload[]
  status: MemoryStatus
  tags: string[]
  updated_at: number
  workspace_id: string | null
}

interface MemoryProcedureRefPayload {
  id: string
  title: string | null
  type: MemoryProcedureRefType
}

const fromMemorySourcePayload = (payload: MemorySourcePayload): MemorySourceRecord => ({
  actorAgentIdSnapshot: payload.actor_agent_id_snapshot,
  actorNameSnapshot: payload.actor_name_snapshot,
  actorRoleSnapshot: payload.actor_role_snapshot,
  createdAt: payload.created_at,
  excerpt: payload.excerpt,
  id: payload.id,
  memoryId: payload.memory_id,
  sourceId: payload.source_id,
  sourceSequence: payload.source_sequence,
  sourceType: payload.source_type,
  textHash: payload.text_hash,
})

const fromMemoryPayload = (payload: MemoryEntryPayload): MemoryEntry => ({
  archivedAt: payload.archived_at,
  body: payload.body,
  confidence: payload.confidence,
  createdAt: payload.created_at,
  disabled: payload.disabled,
  id: payload.id,
  kind: payload.kind,
  lastInjectedAt: payload.last_injected_at,
  pinned: payload.pinned,
  procedureRef: payload.procedure_ref,
  scope: payload.scope,
  source: payload.source,
  sources: payload.sources.map(fromMemorySourcePayload),
  status: payload.status,
  tags: payload.tags,
  updatedAt: payload.updated_at,
  workspaceId: payload.workspace_id,
})

export interface MemoryInjection {
  contextType: 'startup' | 'dispatch' | 'recovery' | 'manual_search'
  dispatchId: string | null
  id: string
  injectedAt: number
  memory: MemoryEntry
  memoryId: string
  targetAgentIdSnapshot: string | null
  workspaceId: string | null
}

interface MemoryInjectionPayload {
  context_type: MemoryInjection['contextType']
  dispatch_id: string | null
  id: string
  injected_at: number
  memory: MemoryEntryPayload
  memory_id: string
  target_agent_id_snapshot: string | null
  workspace_id: string | null
}

const fromMemoryInjectionPayload = (payload: MemoryInjectionPayload): MemoryInjection => ({
  contextType: payload.context_type,
  dispatchId: payload.dispatch_id,
  id: payload.id,
  injectedAt: payload.injected_at,
  memory: fromMemoryPayload(payload.memory),
  memoryId: payload.memory_id,
  targetAgentIdSnapshot: payload.target_agent_id_snapshot,
  workspaceId: payload.workspace_id,
})

export const listWorkspaceMemory = async (
  workspaceId: string,
  input: {
    limit?: number
    query?: string
    scope?: MemoryScope | 'all'
    status?: MemoryStatus | 'all'
  } = {}
): Promise<MemoryEntry[]> => {
  const params = new URLSearchParams()
  if (input.status) params.set('status', input.status)
  if (input.scope) params.set('scope', input.scope)
  if (input.query?.trim()) params.set('query', input.query.trim())
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  const suffix = params.size > 0 ? `?${params}` : ''
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory${suffix}`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load memory'))
  }
  const body = (await response.json()) as { memories: MemoryEntryPayload[] }
  return body.memories.map(fromMemoryPayload)
}

export const updateWorkspaceMemoryEntry = async (
  workspaceId: string,
  memoryId: string,
  input: { disabled?: boolean; pinned?: boolean }
): Promise<MemoryEntry> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/${memoryId}`, {
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update memory'))
  }
  const body = (await response.json()) as { memory: MemoryEntryPayload }
  return fromMemoryPayload(body.memory)
}

const postMemoryAction = async (
  workspaceId: string,
  memoryId: string,
  action: 'approve' | 'archive' | 'reject'
): Promise<MemoryEntry> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${workspaceId}/memory/${memoryId}/${action}`,
    {
      method: 'POST',
    }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Failed to ${action} memory`))
  }
  const body = (await response.json()) as { memory: MemoryEntryPayload }
  return fromMemoryPayload(body.memory)
}

export const approveWorkspaceMemoryCandidate = (workspaceId: string, memoryId: string) =>
  postMemoryAction(workspaceId, memoryId, 'approve')

export const rejectWorkspaceMemoryCandidate = (workspaceId: string, memoryId: string) =>
  postMemoryAction(workspaceId, memoryId, 'reject')

export const archiveWorkspaceMemoryEntry = (workspaceId: string, memoryId: string) =>
  postMemoryAction(workspaceId, memoryId, 'archive')

export interface MemoryDiagnostics {
  dreams: {
    by_status: Record<DreamRunStatus, number>
    last_finished_at: number | null
    last_started_at: number | null
    operations: {
      added: number
      archived: number
      merged: number
      rewritten: number
    }
    total: number
  }
  entries: {
    active_injectable: number
    by_scope: Record<MemoryScope, number>
    by_source: Record<MemorySource, number>
    by_status: Record<MemoryStatus, number>
    disabled: number
    never_injected_active: number
    procedure_refs: number
    stale_active: number
    total: number
  }
  generated_at: number
  injections: {
    by_context: Record<MemoryInjection['contextType'], number>
    distinct_memories: number
    last_injected_at: number | null
    total: number
  }
  provider: {
    provider: 'local_sqlite'
    retrieval: {
      backend: Array<'fts_unicode' | 'fts_trigram' | 'like'>
      fallback: 'sqlite_only'
      semantic_provider: 'not_configured'
    }
  }
  retrieval: {
    query: string | null
    result_count: number
    results: Array<{
      id: string
      index_name: 'like' | 'trigram' | 'unicode'
      kind: MemoryKind
      last_injected_at: number | null
      procedure_ref: MemoryProcedureRef | null
      scope: MemoryScope
      score: number
      status: MemoryStatus
    }>
  }
  workspace_id: string
}

export const getWorkspaceMemoryDiagnostics = async (
  workspaceId: string,
  input: { query?: string; taskText?: string; workerDescription?: string } = {}
): Promise<MemoryDiagnostics> => {
  const params = new URLSearchParams()
  if (input.query?.trim()) params.set('query', input.query.trim())
  if (input.taskText?.trim()) params.set('task_text', input.taskText.trim())
  if (input.workerDescription?.trim()) {
    params.set('worker_description', input.workerDescription.trim())
  }
  const suffix = params.size > 0 ? `?${params}` : ''
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/diagnostics${suffix}`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load memory diagnostics'))
  }
  const body = (await response.json()) as { diagnostics: MemoryDiagnostics }
  return body.diagnostics
}

export type DreamRunStatus = 'running' | 'completed' | 'failed' | 'reverted'
export type DreamRunTrigger = 'manual' | 'scheduled'

export interface DreamRunReport {
  added: Array<{ body: string; id: string; kind: MemoryKind }>
  archived: Array<{ id: string; reason: string | null }>
  merged: Array<{ from: string[]; into: string }>
  rewritten: Array<{ id: string }>
}

export interface DreamRun {
  error: string | null
  finishedAt: number | null
  id: string
  inputSeqFrom: number | null
  inputSeqTo: number | null
  report: DreamRunReport | null
  startedAt: number
  status: DreamRunStatus
  trigger: DreamRunTrigger
  workspaceId: string
}

interface DreamRunPayload {
  error: string | null
  finished_at: number | null
  id: string
  input_seq_from: number | null
  input_seq_to: number | null
  report: DreamRunReport | null
  started_at: number
  status: DreamRunStatus
  trigger: DreamRunTrigger
  workspace_id: string
}

const fromDreamRunPayload = (payload: DreamRunPayload): DreamRun => ({
  error: payload.error,
  finishedAt: payload.finished_at,
  id: payload.id,
  inputSeqFrom: payload.input_seq_from,
  inputSeqTo: payload.input_seq_to,
  report: payload.report,
  startedAt: payload.started_at,
  status: payload.status,
  trigger: payload.trigger,
  workspaceId: payload.workspace_id,
})

export const listWorkspaceMemoryDreamRuns = async (
  workspaceId: string,
  input: { limit?: number } = {}
): Promise<DreamRun[]> => {
  const params = new URLSearchParams()
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  const suffix = params.size > 0 ? `?${params}` : ''
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/dream-runs${suffix}`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load dream runs'))
  }
  const body = (await response.json()) as { runs: DreamRunPayload[] }
  return body.runs.map(fromDreamRunPayload)
}

export const runWorkspaceMemoryDream = async (workspaceId: string): Promise<DreamRun> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/dream-runs`, {
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to run dream'))
  }
  const body = (await response.json()) as { run: DreamRunPayload }
  return fromDreamRunPayload(body.run)
}

export const revertWorkspaceMemoryDreamRun = async (
  workspaceId: string,
  runId: string
): Promise<DreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${workspaceId}/memory/dream-runs/${runId}/revert`,
    {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to revert dream run'))
  }
  const body = (await response.json()) as { run: DreamRunPayload }
  return fromDreamRunPayload(body.run)
}

export interface WorkspaceMemorySettings {
  dreamEnabled: boolean
  enabled: boolean
}

export const getWorkspaceMemorySettings = async (
  workspaceId: string
): Promise<WorkspaceMemorySettings> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/settings`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load memory settings'))
  }
  const body = (await response.json()) as { dream_enabled: boolean; enabled: boolean }
  return { dreamEnabled: body.dream_enabled, enabled: body.enabled }
}

export const updateWorkspaceMemorySettings = async (
  workspaceId: string,
  input: Partial<WorkspaceMemorySettings>
): Promise<WorkspaceMemorySettings> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/settings`, {
    body: JSON.stringify({
      ...(input.dreamEnabled === undefined ? {} : { dream_enabled: input.dreamEnabled }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    }),
    headers: { 'content-type': 'application/json' },
    method: 'PUT',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update memory settings'))
  }
  const body = (await response.json()) as { dream_enabled: boolean; enabled: boolean }
  return { dreamEnabled: body.dream_enabled, enabled: body.enabled }
}

export const listMemoryInjectionsForDispatch = async (
  workspaceId: string,
  dispatchId: string
): Promise<MemoryInjection[]> => {
  const params = new URLSearchParams({ dispatch_id: dispatchId })
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/injections?${params}`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load memory injections'))
  }
  const body = (await response.json()) as { injections: MemoryInjectionPayload[] }
  return body.injections.map(fromMemoryInjectionPayload)
}

// ----- Workflows (M4) -------------------------------------------------------

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'stopped'

export interface WorkflowRun {
  id: string
  workspaceId: string
  scriptPath: string
  name: string
  status: WorkflowRunStatus
  startedAt: number
  finishedAt: number | null
  error: string | null
  phase: string | null
  result: unknown
  /** Args the run was started with — surfaced in the Drawer's run metadata. */
  args: unknown
  /** TIER 1 #14 — number of `agent()` calls dispatched by this run.
   *  Lets the Drawer summarize a run at a glance (phase · N agents · elapsed). */
  agentCount: number
  /** TIER 2 #5 — id of the parent workflow run for nested workflow()
   *  calls. null for top-level runs; the Drawer indents children under
   *  their parent based on this field. */
  parentRunId: string | null
}

interface WorkflowRunPayload {
  id: string
  workspace_id: string
  script_path: string
  script_hash?: string | null
  name: string
  status: WorkflowRunStatus
  started_at: number
  finished_at: number | null
  error: string | null
  phase: string | null
  result?: unknown
  args?: unknown
  agent_count?: number
  parent_run_id?: string | null
}

const fromWorkflowRunPayload = (payload: WorkflowRunPayload): WorkflowRun => ({
  id: payload.id,
  workspaceId: payload.workspace_id,
  scriptPath: payload.script_path,
  name: payload.name,
  status: payload.status,
  startedAt: payload.started_at,
  finishedAt: payload.finished_at,
  error: payload.error,
  phase: payload.phase,
  result: payload.result ?? null,
  args: payload.args ?? null,
  agentCount: typeof payload.agent_count === 'number' ? payload.agent_count : 0,
  parentRunId: payload.parent_run_id ?? null,
})

export const listWorkflowRuns = async (workspaceId: string): Promise<WorkflowRun[]> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workflows/runs`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to list workflow runs'))
  }
  const body = (await response.json()) as { runs: WorkflowRunPayload[] }
  return body.runs.map(fromWorkflowRunPayload)
}

export const getWorkflowRun = async (runId: string): Promise<WorkflowRun> => {
  const response = await apiFetch(`/api/workflows/runs/${runId}`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load workflow run'))
  }
  const body = (await response.json()) as { run: WorkflowRunPayload }
  return fromWorkflowRunPayload(body.run)
}

// ----- Workflow schedules (M3-B / M4.5) ------------------------------------

export interface WorkflowSchedule {
  id: string
  workspaceId: string
  scriptPath: string
  cron: string
  args: unknown
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number
  createdAt: number
  updatedAt: number
}

interface WorkflowSchedulePayload {
  id: string
  workspace_id: string
  script_path: string
  cron: string
  args: unknown
  enabled: boolean
  last_run_at: number | null
  next_run_at: number
  created_at: number
  updated_at: number
}

const fromWorkflowSchedulePayload = (payload: WorkflowSchedulePayload): WorkflowSchedule => ({
  id: payload.id,
  workspaceId: payload.workspace_id,
  scriptPath: payload.script_path,
  cron: payload.cron,
  args: payload.args,
  enabled: payload.enabled,
  lastRunAt: payload.last_run_at,
  nextRunAt: payload.next_run_at,
  createdAt: payload.created_at,
  updatedAt: payload.updated_at,
})

export const listWorkflowSchedules = async (workspaceId: string): Promise<WorkflowSchedule[]> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workflow-schedules`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to list workflow schedules'))
  }
  const body = (await response.json()) as { schedules: WorkflowSchedulePayload[] }
  return body.schedules.map(fromWorkflowSchedulePayload)
}

export const updateWorkflowSchedule = async (
  scheduleId: string,
  input: { cron?: string; args?: unknown; enabled?: boolean }
): Promise<WorkflowSchedule> => {
  const response = await apiFetch(`/api/workflow-schedules/${scheduleId}`, {
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update workflow schedule'))
  }
  const body = (await response.json()) as { schedule: WorkflowSchedulePayload }
  return fromWorkflowSchedulePayload(body.schedule)
}

export interface WorkflowDispatchSummary {
  id: string
  workspaceId: string
  fromAgentId: string | null
  toAgentId: string
  text: string
  status: 'queued' | 'submitted' | 'reported' | 'cancelled'
  reportText: string | null
  reportedAt: number | null
  createdAt: number
  workflowRunId: string | null
  stepIndex: number | null
  phase: string | null
  label: string | null
  /** TIER 2 #6 — last PTY line of the worker, present only when the
   *  dispatch is `submitted` (i.e. the worker is still running and
   *  hasn't reported yet). Lets the Drawer show what each ephemeral
   *  worker is doing without forcing a navigation to its terminal pane. */
  lastPtyLine?: string
}

interface WorkflowDispatchSummaryPayload {
  id: string
  workspace_id: string
  from_agent_id: string | null
  to_agent_id: string
  text: string
  status: 'queued' | 'submitted' | 'reported' | 'cancelled'
  report_text: string | null
  reported_at: number | null
  created_at: number
  workflow_run_id: string | null
  step_index: number | null
  phase: string | null
  label: string | null
  last_pty_line?: string | null
}

const fromWorkflowDispatchPayload = (
  payload: WorkflowDispatchSummaryPayload
): WorkflowDispatchSummary => ({
  id: payload.id,
  workspaceId: payload.workspace_id,
  fromAgentId: payload.from_agent_id,
  toAgentId: payload.to_agent_id,
  text: payload.text,
  status: payload.status,
  reportText: payload.report_text,
  reportedAt: payload.reported_at,
  createdAt: payload.created_at,
  workflowRunId: payload.workflow_run_id,
  stepIndex: payload.step_index,
  phase: payload.phase,
  label: payload.label,
  ...(payload.last_pty_line ? { lastPtyLine: payload.last_pty_line } : {}),
})

export const stopWorkflowRun = async (runId: string): Promise<void> => {
  const response = await apiFetch(`/api/workflows/runs/${runId}/stop`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to stop workflow run'))
  }
}

export const listWorkflowRunDispatches = async (
  runId: string
): Promise<WorkflowDispatchSummary[]> => {
  const response = await apiFetch(`/api/workflows/runs/${runId}/dispatches`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load workflow run dispatches'))
  }
  const body = (await response.json()) as { dispatches: WorkflowDispatchSummaryPayload[] }
  return body.dispatches.map(fromWorkflowDispatchPayload)
}

/** TIER 2 #3 — narrator lane: each `log()` call in a workflow script
 *  appends a row. The Drawer polls this alongside dispatches when a run
 *  is expanded. */
export interface WorkflowRunLogEntry {
  id: number
  ts: number
  message: string
}
export const listWorkflowRunLogs = async (runId: string): Promise<WorkflowRunLogEntry[]> => {
  const response = await apiFetch(`/api/workflows/runs/${runId}/logs`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load workflow run logs'))
  }
  const body = (await response.json()) as { logs: WorkflowRunLogEntry[] }
  return body.logs
}

export const deleteWorkflowSchedule = async (scheduleId: string): Promise<void> => {
  const response = await apiFetch(`/api/workflow-schedules/${scheduleId}`, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete workflow schedule'))
  }
}

// ----- Remote access (M4 — device pairing + management) ---------------------

// The full daemon→gateway tunnel state (mirrors the server's TunnelStatus). The desktop dot reads this
// so it can show connecting / reconnecting / revoked / logged-out — not just a binary connected.
export type RemoteConnectionStatus =
  | 'disabled'
  | 'loggedOut'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'revoked'

export interface RemoteStatus {
  enabled: boolean
  loggedIn: boolean
  gatewayUrl: string | null
  connected: boolean
  /** Full tunnel state for the status dot; `connected` stays as the online shorthand. */
  connection: RemoteConnectionStatus
}

export interface RemoteDeviceView {
  deviceId: string
  name: string
  lastActive: number | null
  createdAt: number
  revoked: boolean
}

export interface PendingPairing {
  pairingId: string
  deviceName: string | null
  sas: string
  expiresAt: number
}

export interface RemoteAuditEntry {
  id: number
  deviceId: string | null
  ts: number
  workspaceId: string | null
  action: string
  endpoint: string | null
  result: 'ok' | 'rejected' | 'error'
  rejectReason: string | null
  byteCount: number | null
  preview: string | null
}

interface RemoteStatusPayload {
  enabled: boolean
  logged_in: boolean
  gateway_url: string | null
  connected: boolean
  connection?: string
}

interface RemoteDevicePayload {
  id: string
  name: string
  last_active: number | null
  created_at: number
  revoked_at: number | null
}

interface PairingTicketPayload {
  pairing_id: string
  qr: string
  code: string
  expires_at: number
}

interface PendingPairingPayload {
  pairing_id: string
  device_name?: string | null
  sas: string
  expires_at: number
}

interface RemoteAuditPayload {
  id: number
  device_id: string | null
  ts: number
  workspace_id: string | null
  action: string
  endpoint: string | null
  result: 'ok' | 'rejected' | 'error'
  reject_reason: string | null
  byte_count: number | null
  preview: string | null
}

const REMOTE_CONNECTION_VALUES: readonly RemoteConnectionStatus[] = [
  'disabled',
  'loggedOut',
  'connecting',
  'online',
  'reconnecting',
  'revoked',
]

const toConnection = (raw: unknown, connected: boolean): RemoteConnectionStatus => {
  if (typeof raw === 'string' && (REMOTE_CONNECTION_VALUES as readonly string[]).includes(raw)) {
    return raw as RemoteConnectionStatus
  }
  // Older daemon that only sent `connected` — derive a coarse state so the dot still works.
  return connected ? 'online' : 'disabled'
}

const requirePayloadString = (value: unknown, field: string): string => {
  if (typeof value === 'string' && value.length > 0) return value
  throw new Error(`Remote payload missing ${field}`)
}

const requirePayloadNumber = (value: unknown, field: string): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error(`Remote payload missing ${field}`)
}

const fromRemoteStatus = (payload: RemoteStatusPayload): RemoteStatus => ({
  // Coerce so the boolean fields are never undefined — a partial body must not
  // flip the enable switch from controlled to uncontrolled mid-render.
  enabled: payload.enabled === true,
  loggedIn: payload.logged_in === true,
  gatewayUrl: payload.gateway_url ?? null,
  connected: payload.connected === true,
  connection: toConnection(payload.connection, payload.connected === true),
})

const fromRemoteDevicePayload = (payload: RemoteDevicePayload): RemoteDeviceView => ({
  deviceId: payload.id,
  name: payload.name,
  lastActive: payload.last_active,
  createdAt: payload.created_at,
  revoked: payload.revoked_at !== null,
})

const fromPairingTicketPayload = (payload: PairingTicketPayload) => ({
  pairingId: requirePayloadString(payload.pairing_id, 'pairing_id'),
  qr: requirePayloadString(payload.qr, 'qr'),
  code: requirePayloadString(payload.code, 'code'),
  expiresAt: requirePayloadNumber(payload.expires_at, 'expires_at'),
})

const fromPendingPairingPayload = (payload: PendingPairingPayload): PendingPairing => ({
  pairingId: requirePayloadString(payload.pairing_id, 'pairing_id'),
  deviceName: payload.device_name ?? null,
  sas: requirePayloadString(payload.sas, 'sas'),
  expiresAt: requirePayloadNumber(payload.expires_at, 'expires_at'),
})

const fromRemoteAuditPayload = (payload: RemoteAuditPayload): RemoteAuditEntry => ({
  id: payload.id,
  deviceId: payload.device_id,
  ts: payload.ts,
  workspaceId: payload.workspace_id,
  action: payload.action,
  endpoint: payload.endpoint,
  result: payload.result,
  rejectReason: payload.reject_reason,
  byteCount: payload.byte_count,
  preview: payload.preview,
})

export const getRemoteStatus = async (): Promise<RemoteStatus> => {
  const response = await apiFetch('/api/remote/status')
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load remote status'))
  }
  return fromRemoteStatus((await response.json()) as RemoteStatusPayload)
}

export const setRemoteEnabled = async (enabled: boolean): Promise<RemoteStatus> => {
  const response = await apiFetch('/api/remote/enabled', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update remote access'))
  }
  return fromRemoteStatus((await response.json()) as RemoteStatusPayload)
}

export const startPairing = async (): Promise<{
  pairingId: string
  qr: string
  code: string
  expiresAt: number
}> => {
  const response = await apiFetch('/api/remote/pairings', { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start pairing'))
  }
  return fromPairingTicketPayload((await response.json()) as PairingTicketPayload)
}

export const getPendingPairing = async (): Promise<PendingPairing | null> => {
  const response = await apiFetch('/api/remote/pairings/pending')
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load pending pairing'))
  }
  const list = (await response.json()) as PendingPairingPayload[]
  const first = list[0]
  return first ? fromPendingPairingPayload(first) : null
}

export const confirmPairing = async (pairingId: string): Promise<void> => {
  const response = await apiFetch(`/api/remote/pairings/${pairingId}/confirm`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to confirm pairing'))
  }
}

export const rejectPairing = async (pairingId: string): Promise<void> => {
  const response = await apiFetch(`/api/remote/pairings/${pairingId}/reject`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to reject pairing'))
  }
}

export const listRemoteDevices = async (): Promise<RemoteDeviceView[]> => {
  const response = await apiFetch('/api/remote/devices')
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load devices'))
  }
  return ((await response.json()) as RemoteDevicePayload[]).map(fromRemoteDevicePayload)
}

export const revokeRemoteDevice = async (deviceId: string): Promise<void> => {
  const response = await apiFetch(`/api/remote/devices/${deviceId}/revoke`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to revoke device'))
  }
}

export const listRemoteAudit = async (limit = 100): Promise<RemoteAuditEntry[]> => {
  const response = await apiFetch(`/api/remote/audit?limit=${limit}`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load remote activity'))
  }
  return ((await response.json()) as RemoteAuditPayload[]).map(fromRemoteAuditPayload)
}

// ----- Action Center -------------------------------------------------------

export type ActionCenterActivityKind = 'cancelled' | 'queued' | 'reported' | 'submitted'

export interface ActionCenterDispatchEvidence {
  createdAt: number
  id: string
  label: string | null
  phase: string | null
  reportPreview: string | null
  status: 'cancelled' | 'queued' | 'reported' | 'submitted'
  submittedAt: number | null
  taskPreview: string | null
  timestamp: number
  toAgentId: string
  toWorkerName: string | null
  workflowRunId: string | null
}

export interface ActionCenterActivity extends ActionCenterDispatchEvidence {
  kind: ActionCenterActivityKind
}

export type ActionCenterAttention =
  | {
      kind: 'question_waiting_answer' | 'message_delivery_pending'
      severity: 'warning'
      dispatchId: string
      messageId: string
      workerId: string
    }
  | {
      kind: 'no_workers'
      severity: 'info'
    }
  | {
      kind: 'stopped_with_queue'
      openDispatches: number
      pendingTaskCount: number
      severity: 'warning'
      workerId: string
      workerName: string
    }
  | {
      dispatchId: string
      kind: 'dispatch_waiting_report'
      minutesAgo: number
      severity: 'info'
      submittedAt: number
      workerId: string
      workerName: string | null
    }
  | {
      action: string
      endpoint: string | null
      kind: 'remote_error' | 'remote_rejected'
      reason: string | null
      severity: 'error' | 'warning'
      ts: number
    }

export interface ActionCenterWorkerEvidence {
  currentDispatch: ActionCenterDispatchEvidence | null
  id: string
  latestReport: ActionCenterDispatchEvidence | null
  name: string
  pendingTaskCount: number
  role: WorkerRole
  status: TeamListItem['status']
  terminalHint: string | null
}

export interface ActionCenterSummary {
  recentDispatchMessages: ActionCenterMessage[]
  attention: ActionCenterAttention[]
  generatedAt: number
  recentActivity: ActionCenterActivity[]
  summary: {
    idleWorkers: number
    openDispatches: number
    recentReports: number
    stoppedWithQueue: number
    stoppedWorkers: number
    totalWorkers: number
    waitingReports: number
    workingWorkers: number
  }
  workers: ActionCenterWorkerEvidence[]
  workspaceId: string
}

interface ActionCenterDispatchPayload {
  created_at: number
  id: string
  label: string | null
  phase: string | null
  report_preview?: string | null
  status: ActionCenterDispatchEvidence['status']
  submitted_at: number | null
  task_preview?: string | null
  timestamp: number
  to_agent_id: string
  to_worker_name: string | null
  workflow_run_id: string | null
}

interface ActionCenterActivityPayload extends ActionCenterDispatchPayload {
  kind: ActionCenterActivityKind
}

interface ActionCenterWorkerPayload {
  current_dispatch: ActionCenterDispatchPayload | null
  id: string
  latest_report: ActionCenterDispatchPayload | null
  name: string
  pending_task_count: number
  role: WorkerRole
  status: TeamListItem['status']
  terminal_hint?: string | null
}

type ActionCenterAttentionPayload =
  | {
      kind: 'question_waiting_answer' | 'message_delivery_pending'
      severity: 'warning'
      dispatch_id: string
      message_id: string
      worker_id: string
    }
  | {
      kind: 'no_workers'
      severity: 'info'
    }
  | {
      kind: 'stopped_with_queue'
      open_dispatches: number
      pending_task_count: number
      severity: 'warning'
      worker_id: string
      worker_name: string
    }
  | {
      dispatch_id: string
      kind: 'dispatch_waiting_report'
      minutes_ago: number
      severity: 'info'
      submitted_at: number
      worker_id: string
      worker_name: string | null
    }
  | {
      action: string
      endpoint: string | null
      kind: 'remote_error' | 'remote_rejected'
      reason: string | null
      severity: 'error' | 'warning'
      ts: number
    }

interface ActionCenterPayload {
  recent_dispatch_messages?: ActionCenterMessage[]
  attention?: ActionCenterAttentionPayload[]
  generated_at: number
  recent_activity: ActionCenterActivityPayload[]
  summary: {
    idle_workers: number
    open_dispatches: number
    recent_reports: number
    stopped_with_queue: number
    stopped_workers: number
    total_workers: number
    waiting_reports?: number
    working_workers: number
  }
  workers: ActionCenterWorkerPayload[]
  workspace_id: string
}

const fromActionCenterAttentionPayload = (
  payload: ActionCenterAttentionPayload
): ActionCenterAttention => {
  if ('message_id' in payload) {
    return {
      kind: payload.kind,
      severity: payload.severity,
      dispatchId: payload.dispatch_id,
      messageId: payload.message_id,
      workerId: payload.worker_id,
    }
  }
  if (payload.kind === 'stopped_with_queue') {
    return {
      kind: payload.kind,
      openDispatches: payload.open_dispatches,
      pendingTaskCount: payload.pending_task_count,
      severity: payload.severity,
      workerId: payload.worker_id,
      workerName: payload.worker_name,
    }
  }
  if (payload.kind === 'dispatch_waiting_report') {
    return {
      dispatchId: payload.dispatch_id,
      kind: payload.kind,
      minutesAgo: payload.minutes_ago,
      severity: payload.severity,
      submittedAt: payload.submitted_at,
      workerId: payload.worker_id,
      workerName: payload.worker_name,
    }
  }
  return payload
}

const fromActionCenterDispatchPayload = (
  payload: ActionCenterDispatchPayload
): ActionCenterDispatchEvidence => ({
  createdAt: payload.created_at,
  id: payload.id,
  label: payload.label,
  phase: payload.phase,
  reportPreview: payload.report_preview ?? null,
  status: payload.status,
  submittedAt: payload.submitted_at,
  taskPreview: payload.task_preview ?? null,
  timestamp: payload.timestamp,
  toAgentId: payload.to_agent_id,
  toWorkerName: payload.to_worker_name,
  workflowRunId: payload.workflow_run_id,
})

const fromActionCenterPayload = (payload: ActionCenterPayload): ActionCenterSummary => ({
  recentDispatchMessages: payload.recent_dispatch_messages ?? [],
  attention: (payload.attention ?? []).map(fromActionCenterAttentionPayload),
  generatedAt: payload.generated_at,
  recentActivity: payload.recent_activity.map((activity) => ({
    ...fromActionCenterDispatchPayload(activity),
    kind: activity.kind,
  })),
  summary: {
    idleWorkers: payload.summary.idle_workers,
    openDispatches: payload.summary.open_dispatches,
    recentReports: payload.summary.recent_reports,
    stoppedWithQueue: payload.summary.stopped_with_queue,
    stoppedWorkers: payload.summary.stopped_workers,
    totalWorkers: payload.summary.total_workers,
    waitingReports: payload.summary.waiting_reports ?? 0,
    workingWorkers: payload.summary.working_workers,
  },
  workers: payload.workers.map((worker) => ({
    currentDispatch: worker.current_dispatch
      ? fromActionCenterDispatchPayload(worker.current_dispatch)
      : null,
    id: worker.id,
    latestReport: worker.latest_report
      ? fromActionCenterDispatchPayload(worker.latest_report)
      : null,
    name: worker.name,
    pendingTaskCount: worker.pending_task_count,
    role: worker.role,
    status: worker.status,
    terminalHint: worker.terminal_hint ?? null,
  })),
  workspaceId: payload.workspace_id,
})

export const getActionCenterSummary = async (
  workspaceId: string,
  init?: RequestInit
): Promise<ActionCenterSummary> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/action-center`, init)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load action center'))
  }
  return fromActionCenterPayload((await response.json()) as ActionCenterPayload)
}

export interface TeamRecap {
  generatedAt: number
  markdown: string
}

interface TeamRecapPayload {
  generated_at: number
  markdown: string
}

export const getTeamRecap = async (workspaceId: string, init?: RequestInit): Promise<TeamRecap> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/recap`, init)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load team recap'))
  }
  const payload = (await response.json()) as TeamRecapPayload
  return { generatedAt: payload.generated_at, markdown: payload.markdown }
}

// ----- Diagnostics ---------------------------------------------------------

export type DiagnosticsSupportBundle = Record<string, unknown>

export type RetentionEvent = 'send' | 'report' | 'status' | 'cancel'

export interface RetentionDailyRow {
  day: string
  send: number
  report: number
  status: number
  cancel: number
}

export interface RetentionSignals {
  first_event_day: string | null
  days_active_total: number
  current_streak_days: number
  totals: Record<RetentionEvent, number>
  daily: RetentionDailyRow[]
}

export const getDiagnosticsSupportBundle = async (): Promise<DiagnosticsSupportBundle> => {
  const response = await apiFetch('/api/diagnostics/support-bundle')
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load diagnostics'))
  }
  return (await response.json()) as DiagnosticsSupportBundle
}

export const getRetentionSignals = async (): Promise<RetentionSignals> => {
  const response = await apiFetch('/api/diagnostics/retention')
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load retention diagnostics'))
  }
  return (await response.json()) as RetentionSignals
}

export const getDispatchMessageHistory = async (
  workspaceId: string,
  dispatchId: string,
  afterMessageId: string | null = null,
  signal?: AbortSignal
): Promise<ActionCenterConversation> => {
  const query = new URLSearchParams({ scope: 'collaboration' })
  if (afterMessageId) query.set('after_message_id', afterMessageId)
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches/${encodeURIComponent(dispatchId)}/messages?${query}`,
    signal ? { signal } : undefined
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to load task messages'))
  return response.json()
}

export type { ControllerStatus as ExternalControllerStatus } from '../../src/shared/types.js'

export const getExternalController = async (workspaceId: string): Promise<ControllerStatus> => {
  const response = await apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/controller`)
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to read controller'))
  return response.json() as Promise<ControllerStatus>
}

export const updateExternalController = async (
  workspaceId: string,
  action: 'confirm' | 'disconnect',
  requestId?: string
): Promise<ControllerStatus> => {
  const response = await apiFetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/controller/${action}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestId ? { request_id: requestId } : {}),
    }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to update controller'))
  return response.json() as Promise<ControllerStatus>
}

export interface ReportedDispatchNotification {
  id: string
  to_agent_id: string
  reported_at: number
  state: 'reported'
}

export const getReportedDispatches = async (
  workspaceId: string,
  since: number | null,
  offset: number,
  signal: AbortSignal
): Promise<{ reports: ReportedDispatchNotification[]; snapshotMs: number }> => {
  const query = new URLSearchParams({
    state: 'reported',
    limit: since === null ? '0' : '100',
    offset: String(offset),
  })
  if (since !== null) query.set('reported_since', String(since))
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches?${query}`,
    { signal }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to read report notifications'))
  const snapshotMs = Number(response.headers.get('x-hive-snapshot-ms'))
  if (!Number.isSafeInteger(snapshotMs) || snapshotMs <= 0)
    throw new Error('Missing report snapshot time')
  return { reports: await response.json(), snapshotMs }
}
