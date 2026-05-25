import { useCallback, useState } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { AppOverlays } from './AppOverlays.js'
import { AppWorkspaceContent } from './AppWorkspaceContent.js'
import { DEMO_TASKS_MD } from './demo/demo-fixture.js'
import { useDemoMode } from './demo/useDemoMode.js'
import { useEffectiveWorkspaceState } from './demo/useEffectiveWorkspaceState.js'
import { MainLayout } from './layout/MainLayout.js'
import { RuntimeOfflinePage } from './pwa/RuntimeOfflinePage.js'
import { UpdateAvailableToast } from './pwa/UpdateAvailableToast.js'
import { useShortcutAction } from './pwa/use-shortcut-action.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { useOptimisticTerminalRuns } from './terminal/useOptimisticTerminalRuns.js'
import { useTerminalRuns } from './terminal/useTerminalRuns.js'
import { useToast } from './ui/useToast.js'
import { useAppShortcuts } from './useAppShortcuts.js'
import { useBeforeUnloadGuard } from './useBeforeUnloadGuard.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useWorkerHighlight } from './useWorkerHighlight.js'
import { useWorkspaceCreate } from './useWorkspaceCreate.js'
import { useWorkspaceDelete } from './useWorkspaceDelete.js'
import { useWorkspaceSelection } from './useWorkspaceSelection.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { useFirstRunWizard } from './wizard/useFirstRunWizard.js'
import { useWorkerActions } from './worker/useWorkerActions.js'
import { OpenWorkspaceButton } from './workspace/OpenWorkspaceButton.js'

export const AppInner = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const { activeWorkspaceId, selectWorkspace, setActiveWorkspaceId } = useWorkspaceSelection()
  const { demoMode, enableDemo, exitDemo } = useDemoMode()
  const localPollIds = demoMode || !workspaces ? [] : workspaces.map(({ id }) => id)
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(localPollIds)
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
  // Always confirm on close. Browsers gate beforeunload on prior page
  // interaction so fresh tabs still close cleanly, but every closure that
  // does fire the prompt now goes through it — including PWA Cmd-W.
  useBeforeUnloadGuard(true)
  const tasksFile = useTasksFile(
    demoMode ? null : (activeWorkspaceId ?? null),
    demoMode ? DEMO_TASKS_MD : undefined
  )
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
  useAppShortcuts({
    bootstrapError,
    onSelectWorkspace: selectWorkspace,
    onTriggerAddDialog: triggerAddDialog,
    workspaces: eff.effectiveWorkspaces,
  })
  // PWA manifest shortcuts route through `?action=...` query params. Wait for
  // bootstrap to *settle* (success OR explicit error) so the dispatcher fires
  // even when the daemon is down — that's exactly when `Try Demo` is most
  // useful, and a stuck-on-loading state would make the shortcut a dead URL.
  useShortcutAction({
    onAddWorkspace: triggerAddDialog,
    onTryDemo: enableDemo,
    ready: demoMode || workspaces !== null || bootstrapError !== null,
  })
  const handleSelectOwner = useWorkerHighlight()
  // Only escalate to the full-screen offline page when bootstrap explicitly
  // failed AND we have no cached workspace data to fall back on AND the user
  // isn't already in demo mode. Mid-session API failures keep the existing
  // toast-based handling.
  const runtimeOffline = bootstrapError !== null && !demoMode && workspaces === null
  return (
    <>
      <MainLayout
        hideTopbarActions={!eff.effectiveActiveWorkspace}
        topbarActions={<OpenWorkspaceButton workspace={eff.effectiveActiveWorkspace} />}
        sidebar={
          <Sidebar
            activeWorkspaceId={eff.effectiveActiveWorkspaceId}
            createDisabledReason={bootstrapError ?? undefined}
            onCreateClick={triggerAddDialog}
            onDeleteWorkspace={deleteWorkspace}
            onReorderWorkspaces={setWorkspaces}
            onSelectWorkspace={selectWorkspace}
            workersByWorkspaceId={eff.effectiveWorkersByWorkspaceId}
            workspaces={eff.effectiveWorkspaces}
          />
        }
      >
        {runtimeOffline ? (
          <RuntimeOfflinePage onTryDemo={enableDemo} />
        ) : (
          <AppWorkspaceContent
            activeId={activeId}
            activeWorkspace={eff.effectiveActiveWorkspace}
            bootstrapError={bootstrapError}
            demoMode={demoMode}
            onDeleteWorkspace={deleteWorkspace}
            onExitDemo={exitDemo}
            onRequestAddWorkspace={triggerAddDialog}
            onShellRunClosed={terms.forgetOptimisticRun}
            onShellRunStarted={(workspaceId, run) =>
              terms.recordOptimisticRun({
                agentId: run.agent_id,
                agentName: run.agent_name,
                runId: run.run_id,
                status: run.status,
                terminalInputProfile: run.terminal_input_profile ?? 'default',
                workspaceId,
              })
            }
            onTryDemo={enableDemo}
            optimisticRunsByWorkspaceId={terms.optimisticRunsByWorkspaceId}
            orchestratorAutostartErrors={wsCreate.orchestratorAutostartErrors}
            orchestratorAutostartRunIds={wsCreate.orchestratorAutostartRunIds}
            recordOrchestratorResult={wsCreate.recordOrchestratorResult}
            tasksFile={tasksFile}
            terminalRuns={terms.terminalRuns}
            workerActions={workerActions}
            workers={activeWorkers}
          />
        )}
        <AppOverlays
          addDialogTrigger={addDialogTrigger}
          wizardOpen={wizardOpen}
          onAddWorkspace={triggerAddDialog}
          onCloseTaskGraph={() => setTaskGraphOpen(false)}
          onCloseWizard={closeWizard}
          onCreateWorkspace={wsCreate.createNewWorkspace}
          onTryDemo={enableDemo}
          taskGraphOpen={taskGraphOpen}
          tasksFile={tasksFile}
          workspaceId={eff.effectiveActiveWorkspace?.id ?? null}
          workspacePath={eff.effectiveActiveWorkspace?.path ?? null}
          workers={activeWorkers}
          onSelectOwner={handleSelectOwner}
        />
      </MainLayout>
      <UpdateAvailableToast terminalRuns={terms.terminalRuns} />
    </>
  )
}
