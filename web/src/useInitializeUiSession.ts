import { useEffect } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import {
  getActiveWorkspaceId,
  initializeUiSession,
  listWorkspaces,
  saveActiveWorkspaceId,
} from './api.js'

const resolveActiveWorkspaceId = (workspaces: WorkspaceSummary[], persistedId: string | null) => {
  if (persistedId && workspaces.some((workspace) => workspace.id === persistedId)) {
    return persistedId
  }
  return workspaces[0]?.id ?? null
}

const mergeWorkspaces = (
  current: WorkspaceSummary[] | null,
  incoming: WorkspaceSummary[]
): WorkspaceSummary[] => {
  if (current === null) return incoming
  const merged = new Map(current.map((workspace) => [workspace.id, workspace]))
  for (const workspace of incoming) {
    merged.set(workspace.id, workspace)
  }
  return Array.from(merged.values())
}

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
      .then(async () => {
        const [items, persistedId] = await Promise.all([
          listWorkspaces(),
          getActiveWorkspaceId().catch(() => null),
        ])
        return { items, persistedId }
      })
      .then(({ items, persistedId }) => {
        if (!cancelled) {
          setWorkspaces((current) => {
            const merged = mergeWorkspaces(current, items)
            const nextActiveWorkspaceId = resolveActiveWorkspaceId(merged, persistedId)
            setActiveWorkspaceId(nextActiveWorkspaceId)
            if (persistedId !== nextActiveWorkspaceId) {
              void saveActiveWorkspaceId(nextActiveWorkspaceId)
            }
            return merged
          })
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
