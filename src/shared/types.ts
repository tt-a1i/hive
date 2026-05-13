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
  /** Optional: last output line shown in the worker card when status is working. */
  lastOutputLine?: string
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
  last_output_line: string | null
}
