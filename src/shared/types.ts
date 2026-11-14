export const agentStatuses = ['idle', 'working', 'stopped'] as const

export type AgentStatus = (typeof agentStatuses)[number]

export const workerRoles = ['coder', 'reviewer', 'tester', 'custom'] as const

export type WorkerRole = (typeof workerRoles)[number]

export const isWorkerRole = (value: unknown): value is WorkerRole =>
  typeof value === 'string' && (workerRoles as readonly string[]).includes(value)

/** How a worker came to exist: spawned by a workflow run or by the orchestrator
 *  (via `team spawn` / `team review`). Absent/null for user-added workers. `ephemeral`
 *  controls lifecycle; `spawnedBy` controls ownership/routing behavior. */
export type WorkerSpawnSource = 'workflow' | 'orchestrator'

/** Roles `team review` may create. Default is reviewer. */
export const teamReviewRoles = ['reviewer', 'tester'] as const
export type TeamReviewRole = (typeof teamReviewRoles)[number]
export const isTeamReviewRole = (value: unknown): value is TeamReviewRole =>
  typeof value === 'string' && (teamReviewRoles as readonly string[]).includes(value)

/** Fixed prefix for the one dispatch created by `team review` (Discussion #76 §3.3.2). */
export const TEAM_REVIEW_TASK_PREFIX =
  'Independent review. Scope: the current uncommitted changes in this workspace (`git status` / `git diff`) unless the focus below names other files or a commit range. Do not edit files. Prioritize real bugs, regressions, and missing edge cases over style nits; if clean, say so briefly. Report findings sorted by severity with file:line, trigger condition, and the smallest credible fix; state residual risk and what you did not verify.'

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
  role: WorkerRole | 'orchestrator' | 'workflow'
  status: AgentStatus
  pendingTaskCount: number
  avatar?: string | null
  ephemeral?: boolean
  spawnedBy?: WorkerSpawnSource | null
  /** Epoch ms when this agent's current run finished post-start injection; null if not ready. */
  startupReadyAt?: number | null
}

export interface TeamListItem {
  id: string
  name: string
  role: WorkerRole
  status: AgentStatus
  pendingTaskCount: number
  description?: string
  configuredCommand?: string | null
  configuredModel?: string | null
  /** Optional user-uploaded avatar. When absent/null, the UI uses the CLI preset logo or role icon. */
  avatar?: string | null
  /**
   * Last raw line printed to the worker's PTY. Kept as non-authoritative UI context only —
   * not a worker reply. Real replies arrive as [Hive 系统消息] entries on orchestrator stdin.
   */
  lastPtyLine?: string
  /**
   * Built-in command preset this worker was launched with. Drives the worker
   * card's CLI logo (§6.4). Undefined when the worker was created without
   * picking a preset, or when the launch config row references a custom command
   * — in that case the UI falls back to the role-letter avatar.
   */
  commandPresetId?: string
  /** Lifecycle marker — true for one-shot workers spawned by `team spawn
   *  --ephemeral`, `team review`, or by the workflow runner (auto-dismissed after their
   *  dispatch). Drives the team panel's visual distinction so workflow-spawned
   *  agents read as the live workflow fleet, not as members of the user's
   *  persistent team (M10). */
  ephemeral?: boolean
  /** Identifies the creator: 'orchestrator' (via `team spawn`) or 'workflow'
   *  (via the workflow runner's `agent()` call). Persistent `team spawn`
   *  workers carry this too, so `team send` can wake them instead of parking
   *  the first dispatch. */
  spawnedBy?: 'orchestrator' | 'workflow'
  /** Epoch ms when this worker's current run finished post-start injection; null if not ready. */
  startupReadyAt?: number | null
}

/**
 * Wire payload shape for /api/workspaces/:id/team and worker-creation responses.
 * Per AGENTS.md §8 + spec §3.3 line 162-179, HTTP JSON is snake_case.
 * Internal TS code uses TeamListItem (camelCase); serializers/deserializers convert.
 */
export interface TeamListOpenDispatchPayload {
  id: string
  status: 'queued' | 'submitted'
  /** Minutes since the dispatch was submitted (or created, while queued). */
  age_minutes: number
  task_preview: string
}

export interface TeamListItemPayload {
  id: string
  name: string
  role: WorkerRole
  status: AgentStatus
  pending_task_count: number
  description?: string
  configured_command?: string | null
  configured_model?: string | null
  avatar?: string | null
  last_pty_line: string | null
  command_preset_id: string | null
  /** Epoch ms when post-start injection finished; null if the worker has no ready run. */
  startup_ready_at: number | null
  ephemeral?: boolean
  spawned_by?: 'orchestrator' | 'workflow' | null
  /** Present (non-empty) only when the worker has open dispatches — gives the
   *  orchestrator the ids + ages it needs for `team cancel`. Display-only:
   *  no timeouts or heartbeats are derived from this. */
  open_dispatches?: TeamListOpenDispatchPayload[]
}

/** Latency percentiles for local collaboration cost (issue #75). */
export interface CollaborationPercentiles {
  p50: number | null
  p95: number | null
}

export interface CollaborationByteStats {
  avg: number | null
  total: number
}

export interface CollaborationDeliverable {
  dispatch_count: number
  first_created_at: number
  injected_bytes: number
  last_reported_at: number | null
  message_count: number
  root_dispatch_id: string
  /** First created_at → last reported_at; null when nothing in the group has reported. */
  wall_clock_ms: number | null
}

export interface CollaborationMetrics {
  cancelled_count: number
  deliverables: CollaborationDeliverable[]
  delivered_to_reported_ms: CollaborationPercentiles
  dispatch_count: number
  dispatch_payload_bytes: CollaborationByteStats
  message_count: number
  report_payload_bytes: CollaborationByteStats
  reported_count: number
  send_to_delivered_ms: CollaborationPercentiles
  window_days: number
  workspace_id: string
}

export type CollaborationMetricsAggregate = Omit<CollaborationMetrics, 'deliverables'>
