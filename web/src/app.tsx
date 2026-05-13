import { useCallback, useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import { AppProviders } from './AppProviders.js'
import { DEMO_TASKS_MD, DEMO_WORKSPACE, DEMO_WORKERS } from './demo/demo-fixture.js'
import { DemoWorkspaceView } from './demo/DemoWorkspaceView.js'
import { useDemoMode } from './demo/useDemoMode.js'
import { MainLayout } from './layout/MainLayout.js'
import { logSwallowed } from './lib/log-swallowed.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { TaskGraphDrawer } from './tasks/TaskGraphDrawer.js'
import { useTasksFile } from './tasks/useTasksFile.js'
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
import { useWorkerActions } from './worker/useWorkerActions.js'
import { AddWorkspaceDialog } from './workspace/AddWorkspaceDialog.js'

const AppInner = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const { activeWorkspaceId, selectWorkspace, setActiveWorkspaceId } = useWorkspaceSelection()
  const { demoMode, enableDemo, exitDemo } = useDemoMode()
  // Pass null to server-polling hooks when in demo mode to prevent server calls
  const pollWorkspaceId = demoMode ? null : activeWorkspaceId
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(pollWorkspaceId)
  const [addDialogTrigger, setAddDialogTrigger] = useState(0)
  const [taskGraphOpen, setTaskGraphOpen] = useState(false)
  const toast = useToast()

  const onBootstrapError = useCallback(
    (message: string) => {
      toast.show({ kind: 'error', message })
    },
    [toast]
  )

  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId, onBootstrapError)

  const {
    orchestratorAutostartErrors,
    orchestratorAutostartRunIds,
    recordOrchestratorResult,
    createNewWorkspace,
  } = useWorkspaceCreate({
    onWorkspaceCreated: (workspace) => {
      setWorkspaces((current) => (current === null ? [workspace] : [...current, workspace]))
      selectWorkspace(workspace.id)
      setWorkersByWorkspaceId((current) => ({ ...current, [workspace.id]: [] }))
    },
  })

  // Effective values: demo mode swaps in fixture data
  const effectiveWorkspaces = demoMode ? [DEMO_WORKSPACE] : workspaces
  const effectiveWorkersByWorkspaceId = demoMode
    ? { [DEMO_WORKSPACE.id]: DEMO_WORKERS }
    : workersByWorkspaceId
  const effectiveActiveWorkspaceId = demoMode ? DEMO_WORKSPACE.id : activeWorkspaceId
  const effectiveActiveWorkspace = demoMode
    ? DEMO_WORKSPACE
    : workspaces?.find((workspace) => workspace.id === activeWorkspaceId)

  // Tasks file: pass demo content to skip server fetch + WS when in demo
  const activeTasksFile = useTasksFile(
    demoMode ? null : activeWorkspaceId,
    demoMode ? DEMO_TASKS_MD : undefined
  )
  const activeWorkers: TeamListItem[] = effectiveActiveWorkspace
    ? (effectiveWorkersByWorkspaceId[effectiveActiveWorkspace.id] ?? [])
    : []
  const rawTerminalRuns = useTerminalRuns(pollWorkspaceId)
  const terminalRunOptimism = useOptimisticTerminalRuns(pollWorkspaceId, rawTerminalRuns)
  const terminalRuns = terminalRunOptimism.terminalRuns
  const workerActions = useWorkerActions({
    activeWorkspaceId,
    onWorkerDeleted: terminalRunOptimism.forgetOptimisticAgent,
    onWorkerRunStarted: terminalRunOptimism.recordOptimisticRun,
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
      hideTopbarActions={!effectiveActiveWorkspace}
      onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
      sidebar={
        <Sidebar
          activeWorkspaceId={effectiveActiveWorkspaceId}
          onCreateClick={() => setAddDialogTrigger((value) => value + 1)}
          onDeleteWorkspace={deleteWorkspace}
          onSelectWorkspace={selectWorkspace}
          workersByWorkspaceId={effectiveWorkersByWorkspaceId}
          workspaces={effectiveWorkspaces}
        />
      }
      taskGraphOpen={taskGraphOpen}
    >
      {/* Terminal panels — skipped in demo mode (no real PTY runs) */}
      {effectiveActiveWorkspace && !demoMode ? (
        <WorkspaceTerminalPanels
          key={`terminal-${effectiveActiveWorkspace.id}`}
          optimisticRuns={
            terminalRunOptimism.optimisticRunsByWorkspaceId[effectiveActiveWorkspace.id] ?? []
          }
          workspaceId={effectiveActiveWorkspace.id}
        />
      ) : null}
      {/* Demo mode: render static demo view without any server-calling hooks */}
      {demoMode ? (
        <DemoWorkspaceView onExit={exitDemo} />
      ) : (
        <WorkspaceDetail
          onCreateWorker={workerActions.createWorker}
          onDeleteWorker={workerActions.deleteWorker}
          onStartWorker={workerActions.startWorker}
          onOrchestratorResult={recordOrchestratorResult}
          onRequestAddWorkspace={() => setAddDialogTrigger((v) => v + 1)}
          onTryDemo={enableDemo}
          orchestratorAutostartError={
            effectiveActiveWorkspace
              ? (orchestratorAutostartErrors[effectiveActiveWorkspace.id] ?? null)
              : null
          }
          orchestratorAutostartRunId={
            effectiveActiveWorkspace
              ? (orchestratorAutostartRunIds[effectiveActiveWorkspace.id] ?? null)
              : null
          }
          terminalRuns={terminalRuns}
          workers={activeWorkers}
          workspace={effectiveActiveWorkspace}
        />
      )}
      {effectiveActiveWorkspace ? (
        <TaskGraphDrawer
          content={activeTasksFile.content}
          hasConflict={activeTasksFile.hasConflict}
          onClose={() => setTaskGraphOpen(false)}
          onContentChange={activeTasksFile.onChange}
          onKeepLocal={activeTasksFile.onKeepLocal}
          onReload={activeTasksFile.onReload}
          onSave={activeTasksFile.onSave}
          onToggleTaskLine={(line) => {
            void activeTasksFile
              .toggleTaskAtLine(line)
              .catch(logSwallowed('tasks.toggleTaskAtLine'))
          }}
          open={taskGraphOpen}
          workspacePath={effectiveActiveWorkspace.path}
        />
      ) : null}
      <AddWorkspaceDialog
        onClose={() => {}}
        onCreate={(input) => {
          void createNewWorkspace(input)
        }}
        trigger={addDialogTrigger}
      />
    </MainLayout>
  )
}

export const App = () => (
  <AppProviders>
    <AppInner />
  </AppProviders>
)
