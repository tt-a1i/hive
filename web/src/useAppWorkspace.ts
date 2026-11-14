import { useCallback, useState } from 'react'
import type { WorkspaceSummary } from '../../src/shared/types.js'
import { useDemoMode } from './demo/useDemoMode.js'
import { useEffectiveWorkspaceState } from './demo/useEffectiveWorkspaceState.js'
import { useOptimisticTerminalRuns } from './terminal/useOptimisticTerminalRuns.js'
import { orchestratorAgentId, useTerminalRuns } from './terminal/useTerminalRuns.js'
import { useToast } from './ui/useToast.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useWorkspaceCreate } from './useWorkspaceCreate.js'
import { useWorkspaceDelete } from './useWorkspaceDelete.js'
import { useWorkspaceSelection } from './useWorkspaceSelection.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { useWorkerActions } from './worker/useWorkerActions.js'

/** Own workspace data and mutations, including optimistic terminal reconciliation. */
export const useAppWorkspace = (onActiveDeleted: () => void) => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const { activeWorkspaceId, selectWorkspace, setActiveWorkspaceId } = useWorkspaceSelection()
  const { demoMode, enableDemo, exitDemo } = useDemoMode()
  const localPollIds = demoMode || !workspaces ? [] : workspaces.map(({ id }) => id)
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(localPollIds, {
    activeWorkspaceId,
  })
  const toast = useToast()
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const onBootstrapError = useCallback(
    (message: string) => {
      setBootstrapError(message)
      toast.show({ kind: 'error', message })
    },
    [toast]
  )
  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId, onBootstrapError)
  const effective = useEffectiveWorkspaceState({
    demoMode,
    workspaces,
    activeWorkspaceId,
    workersByWorkspaceId,
  })
  const activeId = effective.effectiveActiveWorkspace?.id
  const activeWorkers = activeId ? (effective.effectiveWorkersByWorkspaceId[activeId] ?? []) : []
  const polledTerminalRuns = useTerminalRuns(effective.pollWorkspaceId)
  const terms = useOptimisticTerminalRuns(
    effective.pollWorkspaceId,
    polledTerminalRuns,
    activeWorkers
  )
  const create = useWorkspaceCreate({
    onWorkspaceCreated: (workspace) => {
      setWorkspaces((current) => (current === null ? [workspace] : [...current, workspace]))
      selectWorkspace(workspace.id)
      setWorkersByWorkspaceId((current) => ({ ...current, [workspace.id]: [] }))
    },
    onError: (message) => toast.show({ kind: 'error', message }),
    onOrchestratorRunStarted: (workspaceId, runId) =>
      terms.recordOptimisticRun({
        agentId: orchestratorAgentId(workspaceId),
        agentName: 'Orchestrator',
        runId,
        status: 'starting',
        workspaceId,
      }),
  })
  const workerActions = useWorkerActions({
    activeWorkspaceId,
    onWorkerDeleted: terms.forgetOptimisticAgent,
    onWorkerRunClosed: terms.forgetOptimisticRun,
    onWorkerStartFailed: (message) => toast.show({ kind: 'error', message }),
    onWorkerRunStarted: terms.recordOptimisticRun,
    setWorkersByWorkspaceId,
    workers: activeWorkers,
  })
  const deleteWorkspace = useWorkspaceDelete({
    activeWorkspaceId,
    onActiveDeleted,
    selectWorkspace,
    setWorkersByWorkspaceId,
    setWorkspaces,
    workspaces,
  })
  return {
    activeId,
    activeWorkspaceId,
    activeWorkers,
    bootstrapError,
    create,
    deleteWorkspace,
    demoMode,
    effective,
    enableDemo,
    exitDemo,
    selectWorkspace,
    terms,
    workerActions,
    workspaces,
    runtimeOffline: bootstrapError !== null && !demoMode && workspaces === null,
  }
}
export type AppWorkspace = ReturnType<typeof useAppWorkspace>
