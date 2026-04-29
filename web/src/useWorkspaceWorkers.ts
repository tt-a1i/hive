import { useEffect, useState } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import { listWorkers } from './api.js'

const REFRESH_INTERVAL_MS = 500

export const useWorkspaceWorkers = (activeWorkspaceId: string | null) => {
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )

  useEffect(() => {
    if (!activeWorkspaceId) return
    let cancelled = false
    const loadWorkers = () => {
      void listWorkers(activeWorkspaceId)
        .then((items) => {
          if (!cancelled)
            setWorkersByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: items }))
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setWorkersByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: [] }))
          console.error('[hive] swallowed:workspaceWorkers.list', error)
        })
    }
    loadWorkers()
    const interval = window.setInterval(loadWorkers, REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [activeWorkspaceId])

  return [workersByWorkspaceId, setWorkersByWorkspaceId] as const
}
