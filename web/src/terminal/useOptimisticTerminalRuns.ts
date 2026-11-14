import { useCallback, useEffect, useMemo, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { isWorkspaceShellRun, type TerminalInputProfile, type TerminalRunSummary } from '../api.js'

export interface OptimisticRunInput {
  agentId: string
  agentName: string
  runId: string
  status?: string
  terminalInputProfile?: TerminalInputProfile
  workspaceId: string
}

export const mergeTerminalRuns = (
  actualRuns: TerminalRunSummary[],
  optimisticRuns: TerminalRunSummary[],
  workspaceId?: string | null
): TerminalRunSummary[] => {
  const actualRunIds = new Set(actualRuns.map((run) => run.run_id))
  const actualAgentIds = new Set(actualRuns.map((run) => run.agent_id))
  return [
    ...actualRuns,
    ...optimisticRuns.filter((run) => {
      if (actualRunIds.has(run.run_id)) return false
      if (workspaceId && isWorkspaceShellRun(run, workspaceId)) return true
      return !actualAgentIds.has(run.agent_id)
    }),
  ]
}

export const useOptimisticTerminalRuns = (
  workspaceId: string | null,
  actualRuns: TerminalRunSummary[],
  workers: TeamListItem[] = []
) => {
  const [optimisticRunsByWorkspaceId, setOptimisticRunsByWorkspaceId] = useState<
    Record<string, TerminalRunSummary[]>
  >({})

  const forgetOptimisticAgent = useCallback((targetWorkspaceId: string, agentId: string) => {
    setOptimisticRunsByWorkspaceId((current) => ({
      ...current,
      [targetWorkspaceId]: (current[targetWorkspaceId] ?? []).filter(
        (run) => run.agent_id !== agentId
      ),
    }))
  }, [])

  const forgetOptimisticRun = useCallback((targetWorkspaceId: string, runId: string) => {
    setOptimisticRunsByWorkspaceId((current) => ({
      ...current,
      [targetWorkspaceId]: (current[targetWorkspaceId] ?? []).filter((run) => run.run_id !== runId),
    }))
  }, [])

  useEffect(() => {
    if (!workspaceId) return
    const actualRunIds = new Set(actualRuns.map((run) => run.run_id))
    const actualAgentIds = new Set(actualRuns.map((run) => run.agent_id))
    const stoppedWorkerIds = new Set(
      workers.filter((worker) => worker.status === 'stopped').map((worker) => worker.id)
    )
    setOptimisticRunsByWorkspaceId((current) => {
      const currentRuns = current[workspaceId] ?? []
      const retained = currentRuns.filter((run) => {
        if (actualRunIds.has(run.run_id)) return false
        if (isWorkspaceShellRun(run, workspaceId)) return true
        if (actualAgentIds.has(run.agent_id)) return false
        return !stoppedWorkerIds.has(run.agent_id)
      })
      if (retained.length === currentRuns.length) return current
      return { ...current, [workspaceId]: retained }
    })
  }, [actualRuns, workers, workspaceId])

  const recordOptimisticRun = useCallback(
    ({
      agentId,
      agentName,
      runId,
      status = 'starting',
      terminalInputProfile = 'default',
      workspaceId: targetWorkspaceId,
    }: OptimisticRunInput) => {
      const run: TerminalRunSummary = {
        agent_id: agentId,
        agent_name: agentName,
        run_id: runId,
        status,
        terminal_input_profile: terminalInputProfile,
      }
      setOptimisticRunsByWorkspaceId((current) => {
        const recordsWorkspaceShell = isWorkspaceShellRun(run, targetWorkspaceId)
        const retained = (current[targetWorkspaceId] ?? []).filter((item) => {
          if (item.run_id === run.run_id) return false
          if (recordsWorkspaceShell) return true
          return item.agent_id !== run.agent_id
        })
        return { ...current, [targetWorkspaceId]: [...retained, run] }
      })
    },
    []
  )

  const terminalRuns = useMemo(
    () =>
      mergeTerminalRuns(
        actualRuns,
        workspaceId ? (optimisticRunsByWorkspaceId[workspaceId] ?? []) : [],
        workspaceId
      ),
    [actualRuns, optimisticRunsByWorkspaceId, workspaceId]
  )

  return {
    forgetOptimisticAgent,
    forgetOptimisticRun,
    optimisticRunsByWorkspaceId,
    recordOptimisticRun,
    terminalRuns,
  }
}
