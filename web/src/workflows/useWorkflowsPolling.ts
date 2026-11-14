import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import {
  listWorkflowRuns,
  listWorkflowSchedules,
  type WorkflowRun,
  type WorkflowSchedule,
} from '../api.js'

const RUN_POLL_INTERVAL_MS = 2000

interface UseWorkflowsPollingArgs {
  workspaceId: string | null
  enabled: boolean
}

interface UseWorkflowsPollingResult {
  runs: WorkflowRun[]
  schedules: WorkflowSchedule[]
  error: string | null
  loading: boolean
  refresh: () => Promise<void>
  refreshSchedules: () => Promise<void>
}

// A visit has its own cancellation scope, including returning from A to B to A.
export const useWorkflowsPolling = ({
  workspaceId,
  enabled,
}: UseWorkflowsPollingArgs): UseWorkflowsPollingResult => {
  const scope = useMemo(() => ({ workspaceId, enabled }), [workspaceId, enabled])
  const currentScope = useRef<typeof scope | null>(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
    return () => {
      if (currentScope.current === scope) currentScope.current = null
    }
  }, [scope])
  const [state, setState] = useState({
    scope,
    runs: [] as WorkflowRun[],
    schedules: [] as WorkflowSchedule[],
    error: null as string | null,
    loading: false,
  })
  const actions = useRef({ refresh: async () => {}, refreshSchedules: async () => {} })

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const isCurrent = () => !cancelled && currentScope.current === scope
    setState({
      scope,
      runs: [],
      schedules: [],
      error: null,
      loading: Boolean(enabled && workspaceId),
    })
    if (!enabled || !workspaceId) return
    const fetchRuns = async () => {
      try {
        const runs = await listWorkflowRuns(workspaceId)
        if (isCurrent()) setState((current) => ({ ...current, runs }))
      } catch (error) {
        if (isCurrent())
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }))
      }
    }
    const fetchSchedules = async () => {
      try {
        const schedules = await listWorkflowSchedules(workspaceId)
        if (isCurrent()) setState((current) => ({ ...current, schedules }))
      } catch (error) {
        if (isCurrent())
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }))
      }
    }
    const refresh = async () => {
      if (!isCurrent()) return
      setState((current) => ({ ...current, error: null, loading: true }))
      await Promise.all([fetchRuns(), fetchSchedules()])
      if (isCurrent()) setState((current) => ({ ...current, loading: false }))
    }
    actions.current = {
      refresh,
      refreshSchedules: async () => {
        if (isCurrent()) await fetchSchedules()
      },
    }
    const tick = async () => {
      await fetchRuns()
      if (isCurrent()) timer = setTimeout(tick, RUN_POLL_INTERVAL_MS)
    }
    void refresh().then(() => {
      if (isCurrent()) timer = setTimeout(tick, RUN_POLL_INTERVAL_MS)
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [scope, enabled, workspaceId])

  const refresh = useCallback(() => actions.current.refresh(), [])
  const refreshSchedules = useCallback(() => actions.current.refreshSchedules(), [])
  return {
    runs: state.scope === scope ? state.runs : [],
    schedules: state.scope === scope ? state.schedules : [],
    error: state.scope === scope ? state.error : null,
    loading: state.scope === scope ? state.loading : Boolean(enabled && workspaceId),
    refresh,
    refreshSchedules,
  }
}
