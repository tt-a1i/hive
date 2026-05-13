import type { Dispatch, SetStateAction } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import { deleteWorkspace as deleteWorkspaceApi } from './api.js'

type WorkersByWorkspaceId = Record<string, TeamListItem[]>

type WorkspaceDeleteOptions = {
  activeWorkspaceId: string | null
  onActiveDeleted: () => void
  selectWorkspace: (workspaceId: string | null) => void
  setWorkersByWorkspaceId: Dispatch<SetStateAction<WorkersByWorkspaceId>>
  setWorkspaces: Dispatch<SetStateAction<WorkspaceSummary[] | null>>
  workspaces: WorkspaceSummary[] | null
}

export const getNextWorkspaceIdAfterDelete = (
  workspaces: WorkspaceSummary[],
  deletedWorkspaceId: string
): string | null => {
  const deletedIndex = workspaces.findIndex((workspace) => workspace.id === deletedWorkspaceId)
  const remaining = workspaces.filter((workspace) => workspace.id !== deletedWorkspaceId)
  if (deletedIndex < 0) return remaining[0]?.id ?? null
  return remaining[Math.min(deletedIndex, remaining.length - 1)]?.id ?? null
}

/**
 * Returns an async deleter that performs the workspace removal — *no* native
 * confirm or alert. The caller (Sidebar) owns the user-facing confirmation
 * surface (a <Confirm dialog) and the error reporting (toast) so we can keep
 * the dialog/toast UX consistent with the rest of M6-A.
 *
 * The returned function rejects on API failure; the caller catches and toasts.
 */
export const useWorkspaceDelete = ({
  activeWorkspaceId,
  onActiveDeleted,
  selectWorkspace,
  setWorkersByWorkspaceId,
  setWorkspaces,
  workspaces,
}: WorkspaceDeleteOptions) => {
  return async (workspace: WorkspaceSummary): Promise<void> => {
    const currentWorkspaces = workspaces ?? []
    const nextWorkspaceId = getNextWorkspaceIdAfterDelete(currentWorkspaces, workspace.id)

    await deleteWorkspaceApi(workspace.id)
    setWorkspaces((current) => current?.filter((item) => item.id !== workspace.id) ?? current)
    setWorkersByWorkspaceId((current) => {
      const next = { ...current }
      delete next[workspace.id]
      return next
    })
    if (workspace.id === activeWorkspaceId) {
      onActiveDeleted()
      selectWorkspace(nextWorkspaceId)
    }
  }
}
