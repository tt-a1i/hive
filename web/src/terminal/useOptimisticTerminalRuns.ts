import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { TerminalRunSummary } from '../api.js'

const OPTIMISTIC_RUN_TTL_MS = 3000

type TimerId = number

interface OptimisticRunInput {
  agentId: string
  agentName: string
  runId: string
  status?: string
  workspaceId: string
}

export const mergeTerminalRuns = (
  actualRuns: TerminalRunSummary[],
  optimisticRuns: TerminalRunSummary[]
): TerminalRunSummary[] => {
  const actualRunIds = new Set(actualRuns.map((run) => run.run_id))
  const actualAgentIds = new Set(actualRuns.map((run) => run.agent_id))
  return [
    ...actualRuns,
    ...optimisticRuns.filter(
      (run) => !actualRunIds.has(run.run_id) && !actualAgentIds.has(run.agent_id)
    ),
  ]
}

export const useOptimisticTerminalRuns = (
  workspaceId: string | null,
  actualRuns: TerminalRunSummary[]
) => {
  const [optimisticRunsByWorkspaceId, setOptimisticRunsByWorkspaceId] = useState<
    Record<string, TerminalRunSummary[]>
  >({})
  const timersRef = useRef(new Map<string, TimerId>())

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) window.clearTimeout(timer)
      timersRef.current.clear()
    },
    []
  )

  const forgetOptimisticAgent = useCallback((targetWorkspaceId: string, agentId: string) => {
    setOptimisticRunsByWorkspaceId((current) => ({
      ...current,
      [targetWorkspaceId]: (current[targetWorkspaceId] ?? []).filter(
        (run) => run.agent_id !== agentId
      ),
    }))
  }, [])

  const recordOptimisticRun = useCallback(
    ({
      agentId,
      agentName,
      runId,
      status = 'starting',
      workspaceId: targetWorkspaceId,
    }: OptimisticRunInput) => {
      const run: TerminalRunSummary = {
        agent_id: agentId,
        agent_name: agentName,
        run_id: runId,
        status,
      }
      setOptimisticRunsByWorkspaceId((current) => {
        const retained = (current[targetWorkspaceId] ?? []).filter(
          (item) => item.run_id !== run.run_id && item.agent_id !== run.agent_id
        )
        return { ...current, [targetWorkspaceId]: [...retained, run] }
      })

      const existingTimer = timersRef.current.get(runId)
      if (existingTimer) window.clearTimeout(existingTimer)
      const timer = window.setTimeout(() => {
        setOptimisticRunsByWorkspaceId((current) => ({
          ...current,
          [targetWorkspaceId]: (current[targetWorkspaceId] ?? []).filter(
            (item) => item.run_id !== runId
          ),
        }))
        timersRef.current.delete(runId)
      }, OPTIMISTIC_RUN_TTL_MS)
      timersRef.current.set(runId, timer)
    },
    []
  )

  const terminalRuns = useMemo(
    () =>
      mergeTerminalRuns(
        actualRuns,
        workspaceId ? (optimisticRunsByWorkspaceId[workspaceId] ?? []) : []
      ),
    [actualRuns, optimisticRunsByWorkspaceId, workspaceId]
  )

  return {
    forgetOptimisticAgent,
    optimisticRunsByWorkspaceId,
    recordOptimisticRun,
    terminalRuns,
  }
}
