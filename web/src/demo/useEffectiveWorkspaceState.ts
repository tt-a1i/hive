import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'
import { DEMO_WORKERS, DEMO_WORKSPACE } from './demo-fixture.js'

/**
 * Swaps real workspace state for the demo fixture when demo mode is on.
 *
 * Returns `pollWorkspaceId` (null when in demo mode, the active id otherwise)
 * so server-polling hooks can be gated without referencing `demoMode` directly.
 */
export const useEffectiveWorkspaceState = (params: {
  demoMode: boolean
  workspaces: WorkspaceSummary[] | null
  activeWorkspaceId: string | null
  workersByWorkspaceId: Record<string, TeamListItem[]>
}): {
  effectiveActiveWorkspaceId: string | null
  effectiveWorkspaces: WorkspaceSummary[] | null
  effectiveWorkersByWorkspaceId: Record<string, TeamListItem[]>
  effectiveActiveWorkspace: WorkspaceSummary | undefined
  pollWorkspaceId: string | null
} => {
  const { demoMode, workspaces, activeWorkspaceId, workersByWorkspaceId } = params
  const effectiveWorkspaces = demoMode ? [DEMO_WORKSPACE] : workspaces
  const effectiveWorkersByWorkspaceId = demoMode
    ? { [DEMO_WORKSPACE.id]: DEMO_WORKERS }
    : workersByWorkspaceId
  const effectiveActiveWorkspaceId = demoMode ? DEMO_WORKSPACE.id : activeWorkspaceId
  const effectiveActiveWorkspace = demoMode
    ? DEMO_WORKSPACE
    : workspaces?.find((workspace) => workspace.id === activeWorkspaceId)
  const pollWorkspaceId = demoMode ? null : activeWorkspaceId
  return {
    effectiveActiveWorkspaceId,
    effectiveWorkspaces,
    effectiveWorkersByWorkspaceId,
    effectiveActiveWorkspace,
    pollWorkspaceId,
  }
}
