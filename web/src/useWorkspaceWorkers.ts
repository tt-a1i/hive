import { useEffect, useState } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import { listWorkers } from './api.js'

export const useWorkspaceWorkers = (activeWorkspaceId: string | null) => {
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )

  useEffect(() => {
    if (!activeWorkspaceId || workersByWorkspaceId[activeWorkspaceId]) return
    let cancelled = false
    void listWorkers(activeWorkspaceId)
      .then((items) => {
        if (!cancelled)
          setWorkersByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: items }))
      })
      .catch(() => {
        if (!cancelled)
          setWorkersByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: [] }))
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, workersByWorkspaceId])

  return [workersByWorkspaceId, setWorkersByWorkspaceId] as const
}
