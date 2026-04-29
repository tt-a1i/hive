import { useMemo } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import type { TerminalRunSummary } from './api.js'
import { orchestratorAgentId } from './terminal/useTerminalRuns.js'

export interface WorkspaceStats {
  /** PTY active and pending>0 (server promotes via team send). */
  working: number
  /** PTY active, pending=0. */
  idle: number
  /** PTY not running (whatever the queue). spec §3.6.4 allows queued+stopped. */
  stopped: number
  /**
   * Workers with pending_task_count>0. Orchestrator is excluded — it doesn't
   * receive dispatches via team send (it only sends them), and the worker list
   * we ship to the UI excludes orchestrator anyway (spec §3.3.1 `team list`
   * contract). NOT part of working/idle/stopped split — purely informational.
   * spec §3.6.4 says pending_task_count is orthogonal to status.
   */
  queued: number
  /** workers + 1 orchestrator. working + idle + stopped === total. */
  total: number
}

const ORCH_ROLE = 'orchestrator' as const

const classify = (
  agentId: string,
  status: TeamListItem['status'] | typeof ORCH_ROLE,
  pending: number,
  runningAgentIds: Set<string>
): keyof Omit<WorkspaceStats, 'queued' | 'total'> => {
  // Server status is authoritative for `working` / `idle`. We only ever fall
  // back to the running-agent set for an orchestrator-shaped record (which is
  // fed `'orchestrator'` for status from app.tsx) or when the server hasn't
  // settled yet.
  if (status === 'working') return 'working'
  if (status === 'stopped') return 'stopped'
  if (status === 'idle') return 'idle'
  // Orchestrator: derive purely from terminalRuns since we don't ship orch
  // status through the worker list.
  return runningAgentIds.has(agentId) ? (pending > 0 ? 'working' : 'idle') : 'stopped'
}

export const useWorkspaceStats = (
  workspaceId: string | null,
  workers: TeamListItem[],
  terminalRuns: TerminalRunSummary[]
): WorkspaceStats =>
  useMemo(() => {
    if (!workspaceId) return { working: 0, idle: 0, stopped: 0, queued: 0, total: 0 }
    const orchAgentId = orchestratorAgentId(workspaceId)
    const runningAgentIds = new Set(terminalRuns.map((run) => run.agent_id))
    let working = 0
    let idle = 0
    let stopped = 0
    let queued = 0
    for (const worker of workers) {
      const bucket = classify(worker.id, worker.status, worker.pendingTaskCount, runningAgentIds)
      if (bucket === 'working') working += 1
      else if (bucket === 'idle') idle += 1
      else stopped += 1
      if (worker.pendingTaskCount > 0) queued += 1
    }
    const orchBucket = classify(orchAgentId, ORCH_ROLE, 0, runningAgentIds)
    if (orchBucket === 'working') working += 1
    else if (orchBucket === 'idle') idle += 1
    else stopped += 1
    return { working, idle, stopped, queued, total: workers.length + 1 }
  }, [workspaceId, workers, terminalRuns])
