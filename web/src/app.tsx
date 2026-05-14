import { useCallback, useState } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { AppProviders } from './AppProviders.js'
import { DemoWorkspaceView } from './demo/DemoWorkspaceView.js'
import { DEMO_TASKS_MD } from './demo/demo-fixture.js'
import { useDemoMode } from './demo/useDemoMode.js'
import { useEffectiveWorkspaceState } from './demo/useEffectiveWorkspaceState.js'
import { MainLayout } from './layout/MainLayout.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { WorkspaceTaskDrawer } from './tasks/WorkspaceTaskDrawer.js'
import { useOptimisticTerminalRuns } from './terminal/useOptimisticTerminalRuns.js'
import { useTerminalRuns } from './terminal/useTerminalRuns.js'
import { useToast } from './ui/useToast.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useWorkspaceCreate } from './useWorkspaceCreate.js'
import { useWorkspaceDelete } from './useWorkspaceDelete.js'
import { useWorkspaceSelection } from './useWorkspaceSelection.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'
import { FirstRunWizard } from './wizard/FirstRunWizard.js'
import { useFirstRunWizard } from './wizard/useFirstRunWizard.js'
import { useWorkerActions } from './worker/useWorkerActions.js'
import { AddWorkspaceDialog } from './workspace/AddWorkspaceDialog.js'

const AppInner = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const { activeWorkspaceId, selectWorkspace, setActiveWorkspaceId } = useWorkspaceSelection()
  const { demoMode, enableDemo, exitDemo } = useDemoMode()
  const localPollId = demoMode ? null : activeWorkspaceId
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(localPollId)
  const [addDialogTrigger, setAddDialogTrigger] = useState(0)
  const [taskGraphOpen, setTaskGraphOpen] = useState(false)
  const toast = useToast()
  const { wizardOpen, closeWizard } = useFirstRunWizard(workspaces)
  const triggerAddDialog = useCallback(() => setAddDialogTrigger((v) => v + 1), [])
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const onBootstrapError = useCallback(
    (message: string) => {
      setBootstrapError(message)
      toast.show({ kind: 'error', message })
    },
    [toast]
  )
  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId, onBootstrapError)
  const wsCreate = useWorkspaceCreate({
    onWorkspaceCreated: (ws) => {
      setWorkspaces((c) => (c === null ? [ws] : [...c, ws]))
      selectWorkspace(ws.id)
      setWorkersByWorkspaceId((c) => ({ ...c, [ws.id]: [] }))
    },
    onError: (message) => toast.show({ kind: 'error', message }),
  })
  const wsState = { demoMode, workspaces, activeWorkspaceId, workersByWorkspaceId }
  const eff = useEffectiveWorkspaceState(wsState)
  const activeId = eff.effectiveActiveWorkspace?.id
  const activeWorkers = activeId ? (eff.effectiveWorkersByWorkspaceId[activeId] ?? []) : []
  const terms = useOptimisticTerminalRuns(eff.pollWorkspaceId, useTerminalRuns(eff.pollWorkspaceId))
  const workerActions = useWorkerActions({
    activeWorkspaceId,
    onWorkerDeleted: terms.forgetOptimisticAgent,
    onWorkerRunStarted: terms.recordOptimisticRun,
    setWorkersByWorkspaceId,
  })
  const deleteWorkspace = useWorkspaceDelete({
    activeWorkspaceId,
    onActiveDeleted: () => setTaskGraphOpen(false),
    selectWorkspace,
    setWorkersByWorkspaceId,
    setWorkspaces,
    workspaces,
  })
  return (
    <MainLayout
      hideTopbarActions={!eff.effectiveActiveWorkspace}
      onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
      sidebar={
        <Sidebar
          activeWorkspaceId={eff.effectiveActiveWorkspaceId}
          createDisabledReason={bootstrapError ?? undefined}
          onCreateClick={triggerAddDialog}
          onDeleteWorkspace={deleteWorkspace}
          onSelectWorkspace={selectWorkspace}
          workersByWorkspaceId={eff.effectiveWorkersByWorkspaceId}
          workspaces={eff.effectiveWorkspaces}
        />
      }
      taskGraphOpen={taskGraphOpen}
    >
      {activeId && !demoMode ? (
        <WorkspaceTerminalPanels
          key={`terminal-${activeId}`}
          optimisticRuns={terms.optimisticRunsByWorkspaceId[activeId] ?? []}
          workspaceId={activeId}
        />
      ) : null}
      {demoMode ? (
        <DemoWorkspaceView onExit={exitDemo} />
      ) : (
        <WorkspaceDetail
          onCreateWorker={workerActions.createWorker}
          onDeleteWorker={workerActions.deleteWorker}
          onStartWorker={workerActions.startWorker}
          onOrchestratorResult={wsCreate.recordOrchestratorResult}
          onRequestAddWorkspace={triggerAddDialog}
          onTryDemo={enableDemo}
          welcomeDisabledReason={bootstrapError ?? undefined}
          orchestratorAutostartError={
            activeId ? (wsCreate.orchestratorAutostartErrors[activeId] ?? null) : null
          }
          orchestratorAutostartRunId={
            activeId ? (wsCreate.orchestratorAutostartRunIds[activeId] ?? null) : null
          }
          terminalRuns={terms.terminalRuns}
          workers={activeWorkers}
          workspace={eff.effectiveActiveWorkspace}
        />
      )}
      {eff.effectiveActiveWorkspace ? (
        <WorkspaceTaskDrawer
          demoMode={demoMode}
          demoContent={DEMO_TASKS_MD}
          workspaceId={activeWorkspaceId}
          workspacePath={eff.effectiveActiveWorkspace.path}
          open={taskGraphOpen}
          onClose={() => setTaskGraphOpen(false)}
        />
      ) : null}
      <AddWorkspaceDialog
        onClose={() => {}}
        onCreate={wsCreate.createNewWorkspace}
        trigger={addDialogTrigger}
      />
      <FirstRunWizard
        open={wizardOpen}
        onClose={closeWizard}
        onAddWorkspace={triggerAddDialog}
        onTryDemo={enableDemo}
      />
    </MainLayout>
  )
}

export const App = () => (
  <AppProviders>
    <AppInner />
  </AppProviders>
)
