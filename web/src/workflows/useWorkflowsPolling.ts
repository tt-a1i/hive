import { useCallback, useEffect, useRef, useState } from 'react'

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

// Workflows are authored + fired by the orchestrator agent, so this drawer is
// observation-only: it polls runs (every 2s while open) and lists schedules
// (once on open + on schedule mutations). There is no script library to fetch.
export const useWorkflowsPolling = ({
  workspaceId,
  enabled,
}: UseWorkflowsPollingArgs): UseWorkflowsPollingResult => {
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const cancelledRef = useRef(false)
  const scheduleRequestRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchRuns = useCallback(async () => {
    if (!workspaceId) return
    try {
      const next = await listWorkflowRuns(workspaceId)
      if (!cancelledRef.current) setRuns(next)
    } catch (e) {
      if (!cancelledRef.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [workspaceId])

  const fetchSchedules = useCallback(async () => {
    if (!workspaceId) return
    // An older list can predate a pause/resume already reconciled by a newer read.
    const request = ++scheduleRequestRef.current
    try {
      const next = await listWorkflowSchedules(workspaceId)
      if (!cancelledRef.current && request === scheduleRequestRef.current) setSchedules(next)
    } catch (e) {
      if (!cancelledRef.current && request === scheduleRequestRef.current)
        setError(e instanceof Error ? e.message : String(e))
    }
  }, [workspaceId])

  const refresh = useCallback(async () => {
    if (!workspaceId || !enabled) return
    setLoading(true)
    try {
      await Promise.all([fetchRuns(), fetchSchedules()])
    } finally {
      if (!cancelledRef.current) setLoading(false)
    }
  }, [workspaceId, enabled, fetchRuns, fetchSchedules])

  const refreshSchedules = useCallback(async () => {
    await fetchSchedules()
  }, [fetchSchedules])

  useEffect(() => {
    scheduleRequestRef.current += 1
    cancelledRef.current = false
    if (!enabled || !workspaceId) {
      return () => {
        cancelledRef.current = true
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }
    }

    setError(null)
    setLoading(true)
    Promise.all([fetchRuns(), fetchSchedules()]).finally(() => {
      if (!cancelledRef.current) setLoading(false)
    })

    const tick = async () => {
      if (cancelledRef.current) return
      await fetchRuns()
      if (cancelledRef.current) return
      timerRef.current = setTimeout(tick, RUN_POLL_INTERVAL_MS)
    }
    timerRef.current = setTimeout(tick, RUN_POLL_INTERVAL_MS)

    return () => {
      cancelledRef.current = true
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [enabled, workspaceId, fetchRuns, fetchSchedules])

  return { runs, schedules, error, loading, refresh, refreshSchedules }
}
