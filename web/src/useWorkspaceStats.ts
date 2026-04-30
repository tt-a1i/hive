import { useMemo } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import type { TerminalRunSummary } from './api.js'

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
  /** Team members only. working + idle + stopped === total. */
  total: number
}

const classify = (
  status: TeamListItem['status']
): keyof Omit<WorkspaceStats, 'queued' | 'total'> => {
  if (status === 'working') return 'working'
  if (status === 'stopped') return 'stopped'
  return 'idle'
}

export const useWorkspaceStats = (
  workspaceId: string | null,
  workers: TeamListItem[],
  _terminalRuns: TerminalRunSummary[]
): WorkspaceStats =>
  useMemo(() => {
    if (!workspaceId) return { working: 0, idle: 0, stopped: 0, queued: 0, total: 0 }
    let working = 0
    let idle = 0
    let stopped = 0
    let queued = 0
    for (const worker of workers) {
      const bucket = classify(worker.status)
      if (bucket === 'working') working += 1
      else if (bucket === 'idle') idle += 1
      else stopped += 1
      if (worker.pendingTaskCount > 0) queued += 1
    }
    return { working, idle, stopped, queued, total: workers.length }
  }, [workspaceId, workers])
