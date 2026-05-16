export const agentStatuses = ['idle', 'working', 'stopped'] as const

export type AgentStatus = (typeof agentStatuses)[number]

export type WorkerRole = 'coder' | 'reviewer' | 'tester' | 'custom'

export interface WorkspaceSummary {
  id: string
  name: string
  path: string
}

export interface AgentSummary {
  id: string
  workspaceId: string
  name: string
  description: string
  role: WorkerRole | 'orchestrator'
  status: AgentStatus
  pendingTaskCount: number
}

export interface TeamListItem {
  id: string
  name: string
  role: WorkerRole
  status: AgentStatus
  pendingTaskCount: number
  /**
   * Last raw line printed to the worker's PTY. Surfaced on the worker card for UI hints only —
   * not a worker reply. Real replies arrive as [Hive 系统消息] entries on orchestrator stdin.
   */
  lastPtyLine?: string
  /**
   * Built-in command preset this worker was launched with (`claude` / `codex` /
   * `opencode` / `gemini`). Drives the worker card's CLI logo (§6.4). Undefined
   * when the worker was created without picking a preset, or when the launch
   * config row references a custom command — in that case the UI falls back to
   * the role-letter avatar.
   */
  commandPresetId?: string
}

/**
 * Wire payload shape for /api/workspaces/:id/team and worker-creation responses.
 * Per AGENTS.md §8 + spec §3.3 line 162-179, HTTP JSON is snake_case.
 * Internal TS code uses TeamListItem (camelCase); serializers/deserializers convert.
 */
export interface TeamListItemPayload {
  id: string
  name: string
  role: WorkerRole
  status: AgentStatus
  pending_task_count: number
  last_pty_line: string | null
  command_preset_id: string | null
}
