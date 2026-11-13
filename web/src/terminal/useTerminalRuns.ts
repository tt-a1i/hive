import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { listTerminalRuns, type TerminalRunSummary } from '../api.js'

const STARTING_REFRESH_INTERVAL_MS = 500
const STEADY_REFRESH_INTERVAL_MS = 2500
const MAX_REFRESH_INTERVAL_MS = 5000
const HIDDEN_REFRESH_INTERVAL_MS = 15000

const isStartingTerminalRun = (run: TerminalRunSummary) => run.status === 'starting'

const getRefreshDelay = (failureCount: number, runs: TerminalRunSummary[]) => {
  if (failureCount > 0) {
    return Math.min(STARTING_REFRESH_INTERVAL_MS * 2 ** failureCount, MAX_REFRESH_INTERVAL_MS)
  }
  return runs.some(isStartingTerminalRun)
    ? STARTING_REFRESH_INTERVAL_MS
    : STEADY_REFRESH_INTERVAL_MS
}

export const orchestratorAgentId = (workspaceId: string) => `${workspaceId}:orchestrator`

const areTerminalRunsEqual = (a: TerminalRunSummary[], b: TerminalRunSummary[]): boolean => {
  if (a.length !== b.length) return false
  return a.every((run, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      run.agent_id === other.agent_id &&
      run.agent_name === other.agent_name &&
      run.run_id === other.run_id &&
      run.status === other.status &&
      run.terminal_input_profile === other.terminal_input_profile
    )
  })
}

export const useTerminalRuns = (workspaceId: string | null): TerminalRunSummary[] => {
  const scope = useMemo(() => ({ workspaceId }), [workspaceId])
  const currentScope = useRef<typeof scope | null>(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
    return () => {
      if (currentScope.current === scope) currentScope.current = null
    }
  }, [scope])
  const [result, setResult] = useState({ scope, runs: [] as TerminalRunSummary[] })

  useEffect(() => {
    if (!workspaceId) {
      setResult({ scope, runs: [] })
      return
    }
    let cancelled = false
    setResult({ scope, runs: [] })
    const isCurrent = () => !cancelled && currentScope.current === scope
    let failureCount = 0
    let inFlight = false
    let lastRuns: TerminalRunSummary[] = []
    let timeout: number | undefined
    const scheduleNextLoad = () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
      if (isCurrent())
        timeout = window.setTimeout(
          loadRuns,
          document.visibilityState === 'hidden'
            ? HIDDEN_REFRESH_INTERVAL_MS
            : getRefreshDelay(failureCount, lastRuns)
        )
    }
    const loadRuns = () => {
      if (inFlight || !isCurrent()) return
      inFlight = true
      void listTerminalRuns(workspaceId)
        .then((runs) => {
          if (!isCurrent()) return
          failureCount = 0
          lastRuns = runs
          setResult((current) =>
            current.scope === scope && areTerminalRunsEqual(current.runs, runs)
              ? current
              : { scope, runs }
          )
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return
          failureCount = Math.min(failureCount + 1, 4)
          console.error('[hive] swallowed:terminalRuns.list', error)
        })
        .finally(() => {
          inFlight = false
          scheduleNextLoad()
        })
    }
    const onVisibilityChange = () => {
      if (timeout !== undefined) {
        window.clearTimeout(timeout)
        timeout = undefined
      }
      if (document.visibilityState === 'visible') loadRuns()
      else if (!inFlight) scheduleNextLoad()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    loadRuns()
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [workspaceId, scope])

  return result.scope === scope ? result.runs : []
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
