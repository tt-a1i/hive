import { useCallback, useRef, useState } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { AppOverlays } from './AppOverlays.js'
import { AppProviders } from './AppProviders.js'
import { AppWorkspaceContent } from './AppWorkspaceContent.js'
import { DEMO_TASKS_MD } from './demo/demo-fixture.js'
import { useDemoMode } from './demo/useDemoMode.js'
import { useEffectiveWorkspaceState } from './demo/useEffectiveWorkspaceState.js'
import { MainLayout } from './layout/MainLayout.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { parseTaskMarkdown } from './tasks/task-markdown.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { useOptimisticTerminalRuns } from './terminal/useOptimisticTerminalRuns.js'
import { useTerminalRuns } from './terminal/useTerminalRuns.js'
import { useToast } from './ui/useToast.js'
import { useAppShortcuts } from './useAppShortcuts.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useWorkspaceCreate } from './useWorkspaceCreate.js'
import { useWorkspaceDelete } from './useWorkspaceDelete.js'
import { useWorkspaceSelection } from './useWorkspaceSelection.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { useFirstRunWizard } from './wizard/useFirstRunWizard.js'
import { useWorkerActions } from './worker/useWorkerActions.js'

const AppInner = () => {
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
  const tasksFile = useTasksFile(
    demoMode ? null : (activeWorkspaceId ?? null),
    demoMode ? DEMO_TASKS_MD : undefined
  )
  const openTaskCount = eff.effectiveActiveWorkspace
    ? parseTaskMarkdown(tasksFile.content).filter((task) => !task.checked).length
    : 0
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
    activeWorkspace: eff.effectiveActiveWorkspace,
    bootstrapError,
    onSelectWorkspace: selectWorkspace,
    onToggleTaskGraph: () => setTaskGraphOpen((open) => !open),
    onTriggerAddDialog: triggerAddDialog,
    workspaces: eff.effectiveWorkspaces,
  })

  // §6.6.6 — clicking an `@<worker>` chip in the Tasks drawer scrolls the
  // matching worker card into view and applies a transient highlight. We
  // look up by `data-worker-name` (set on the WorkerCard root); the timer
  // ref ensures rapid-fire clicks don't strand a stale "fading" class.
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSelectOwner = useCallback((workerName: string) => {
    if (typeof document === 'undefined') return
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(workerName)
        : workerName.replace(/"/g, '\\"')
    const target = document.querySelector<HTMLElement>(`[data-worker-name="${escaped}"]`)
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    target.classList.add('worker-card-shell--highlight')
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current)
    highlightTimeoutRef.current = setTimeout(() => {
      target.classList.remove('worker-card-shell--highlight')
      highlightTimeoutRef.current = null
    }, 1000)
  }, [])
  return (
    <MainLayout
      hideTopbarActions={!eff.effectiveActiveWorkspace}
      onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
      openTaskCount={openTaskCount}
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
      <AppWorkspaceContent
        activeId={activeId}
        activeWorkspace={eff.effectiveActiveWorkspace}
        bootstrapError={bootstrapError}
        demoMode={demoMode}
        onDeleteWorkspace={deleteWorkspace}
        onExitDemo={exitDemo}
        onRequestAddWorkspace={triggerAddDialog}
        onTryDemo={enableDemo}
        optimisticRunsByWorkspaceId={terms.optimisticRunsByWorkspaceId}
        orchestratorAutostartErrors={wsCreate.orchestratorAutostartErrors}
        orchestratorAutostartRunIds={wsCreate.orchestratorAutostartRunIds}
        recordOrchestratorResult={wsCreate.recordOrchestratorResult}
        terminalRuns={terms.terminalRuns}
        workerActions={workerActions}
        workers={activeWorkers}
      />
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
        workspacePath={eff.effectiveActiveWorkspace?.path ?? null}
        workers={activeWorkers}
        onSelectOwner={handleSelectOwner}
      />
    </MainLayout>
  )
}

export const App = () => (
  <AppProviders>
    <AppInner />
  </AppProviders>
)
