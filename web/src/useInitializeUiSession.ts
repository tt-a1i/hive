import { useEffect } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { initializeUiSession, listWorkspaces } from './api.js'

export const useInitializeUiSession = (
  setWorkspaces: (
    value:
      | WorkspaceSummary[]
      | null
      | ((current: WorkspaceSummary[] | null) => WorkspaceSummary[] | null)
  ) => void,
  setActiveWorkspaceId: (value: string | null) => void
) => {
  useEffect(() => {
    let cancelled = false
    void initializeUiSession()
      .then(() => listWorkspaces())
      .then((items) => {
        if (!cancelled) {
          setWorkspaces(items)
          setActiveWorkspaceId(items[0]?.id ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaces([])
          setActiveWorkspaceId(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [setActiveWorkspaceId, setWorkspaces])
}
