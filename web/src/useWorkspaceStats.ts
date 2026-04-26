import { useMemo } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import type { TerminalRunSummary } from './api.js'
import { orchestratorAgentId } from './terminal/useTerminalRuns.js'

export interface WorkspaceStats {
  /** PTY processes currently alive (worker + orchestrator). */
  running: number
  /** Workers with pending dispatch but stopped PTY (spec §3.6.4). */
  queued: number
  /** Workers (and orchestrator) whose PTY is not running. */
  stopped: number
  /** workers + 1 orchestrator. */
  total: number
}

export const useWorkspaceStats = (
  workspaceId: string | null,
  workers: TeamListItem[],
  terminalRuns: TerminalRunSummary[]
): WorkspaceStats =>
  useMemo(() => {
    if (!workspaceId) return { running: 0, queued: 0, stopped: 0, total: 0 }
    const orchAgentId = orchestratorAgentId(workspaceId)
    const runningAgentIds = new Set(terminalRuns.map((run) => run.agent_id))
    let running = 0
    let queued = 0
    let stopped = 0
    for (const worker of workers) {
      if (runningAgentIds.has(worker.id)) running += 1
      else stopped += 1
      if (worker.status === 'stopped' && worker.pendingTaskCount > 0) queued += 1
    }
    if (runningAgentIds.has(orchAgentId)) running += 1
    else stopped += 1
    return { running, queued, stopped, total: workers.length + 1 }
  }, [workspaceId, workers, terminalRuns])
