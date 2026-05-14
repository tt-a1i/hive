import { useEffect, useState } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import { listWorkers } from './api.js'

const REFRESH_INTERVAL_MS = 500
const MAX_REFRESH_INTERVAL_MS = 5000

const getRefreshDelay = (failureCount: number) =>
  Math.min(REFRESH_INTERVAL_MS * 2 ** failureCount, MAX_REFRESH_INTERVAL_MS)

export const useWorkspaceWorkers = (workspaceIds: readonly string[]) => {
  const workspaceKey = workspaceIds.join('\0')
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )

  useEffect(() => {
    if (!workspaceKey) {
      setWorkersByWorkspaceId({})
      return
    }
    let cancelled = false
    let inFlight = false
    let failureCount = 0
    let timeout: number | undefined
    const ids = workspaceKey.split('\0')
    const scheduleNextLoad = () => {
      if (!cancelled) timeout = window.setTimeout(loadWorkers, getRefreshDelay(failureCount))
    }
    const loadWorkers = () => {
      if (inFlight) return
      inFlight = true
      void Promise.all(
        ids.map(async (workspaceId) => {
          try {
            return [workspaceId, await listWorkers(workspaceId)] as const
          } catch (error) {
            console.error('[hive] swallowed:workspaceWorkers.list', error)
            return null
          }
        })
      )
        .then((results) => {
          if (cancelled) return
          failureCount = results.some(Boolean) ? 0 : Math.min(failureCount + 1, 4)
          setWorkersByWorkspaceId((current) => {
            const next: Record<string, TeamListItem[]> = {}
            for (const workspaceId of ids) next[workspaceId] = current[workspaceId] ?? []
            for (const result of results) {
              if (result) next[result[0]] = result[1]
            }
            return next
          })
        })
        .finally(() => {
          inFlight = false
          scheduleNextLoad()
        })
    }
    loadWorkers()
    return () => {
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [workspaceKey])

  return [workersByWorkspaceId, setWorkersByWorkspaceId] as const
}
