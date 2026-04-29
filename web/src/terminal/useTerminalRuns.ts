import { useEffect, useState } from 'react'

import { listTerminalRuns, type TerminalRunSummary } from '../api.js'

const REFRESH_INTERVAL_MS = 500

export const orchestratorAgentId = (workspaceId: string) => `${workspaceId}:orchestrator`

export const useTerminalRuns = (workspaceId: string | null): TerminalRunSummary[] => {
  const [terminalRuns, setTerminalRuns] = useState<TerminalRunSummary[]>([])

  useEffect(() => {
    if (!workspaceId) {
      setTerminalRuns([])
      return
    }
    let cancelled = false
    const loadRuns = () => {
      void listTerminalRuns(workspaceId)
        .then((runs) => {
          if (!cancelled) setTerminalRuns(runs)
        })
        .catch((error: unknown) => {
          if (!cancelled) setTerminalRuns([])
          console.error('[hive] swallowed:terminalRuns.list', error)
        })
    }
    loadRuns()
    const interval = window.setInterval(loadRuns, REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [workspaceId])

  return terminalRuns
}

export const findOrchestratorRun = (
  runs: TerminalRunSummary[],
  workspaceId: string
): TerminalRunSummary | undefined =>
  runs.find((run) => run.agent_id === orchestratorAgentId(workspaceId))

export const findRunByAgentId = (
  runs: TerminalRunSummary[],
  agentId: string
): TerminalRunSummary | undefined => runs.find((run) => run.agent_id === agentId)
