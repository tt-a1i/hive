import type {
  AgentSummary,
  TeamListItem,
  TeamListItemPayload,
  WorkerRole,
  WorkspaceSummary,
} from '../../src/shared/types.js'

const fromPayload = (payload: TeamListItemPayload): TeamListItem => ({
  id: payload.id,
  name: payload.name,
  role: payload.role,
  status: payload.status,
  pendingTaskCount: payload.pending_task_count,
  lastOutputLine: payload.last_output_line ?? undefined,
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
  const response = await fetch('/api/ui/session', { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error('Failed to initialize UI session')
  }
  await response.json()
}

const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init)
  if (!(await isStaleUiSession(response))) return response

  await initializeUiSession()
  return fetch(input, init)
}

export const listWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await apiFetch('/api/workspaces')

  if (!response.ok) {
    throw new Error('Failed to load workspaces')
  }

  return (await response.json()) as WorkspaceSummary[]
}

export interface OrchestratorStartResult {
  ok: boolean
  error: string | null
  run_id: string | null
}

export interface CommandPreset {
  args: string[]
  command: string
  displayName: string
  id: string
}

export interface RoleTemplate {
  description: string
  id: string
  name: string
  roleType: WorkerRole | 'orchestrator'
}

interface CommandPresetPayload {
  args: string[]
  command: string
  display_name: string
  id: string
}

interface RoleTemplatePayload {
  description: string
  id: string
  name: string
  role_type: WorkerRole | 'orchestrator'
}

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
  autostart_orchestrator?: boolean
  command_preset_id?: string | null
}): Promise<CreateWorkspaceResponse> => {
  const response = await apiFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error('Failed to create workspace')
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
    command: preset.command,
    displayName: preset.display_name,
    id: preset.id,
  }))
}

export interface TerminalRunSummary {
  agent_id: string
  agent_name: string
  run_id: string
  status: string
}

export const listRoleTemplates = async (): Promise<RoleTemplate[]> => {
  const response = await apiFetch('/api/settings/role-templates', {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load role templates')
  }

  const payload = (await response.json()) as RoleTemplatePayload[]
  return payload.map((template) => ({
    description: template.description,
    id: template.id,
    name: template.name,
    roleType: template.role_type,
  }))
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
    command_preset_id?: string | null
    description?: string
    role: WorkerRole
  }
): Promise<CreateWorkerResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error('Failed to create worker')
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
