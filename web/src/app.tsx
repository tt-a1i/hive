import { useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import { AppProviders } from './AppProviders.js'
import { MainLayout } from './layout/MainLayout.js'
import { logSwallowed } from './lib/log-swallowed.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { TaskGraphDrawer } from './tasks/TaskGraphDrawer.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { useOptimisticTerminalRuns } from './terminal/useOptimisticTerminalRuns.js'
import { useTerminalRuns } from './terminal/useTerminalRuns.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useWorkspaceCreate } from './useWorkspaceCreate.js'
import { useWorkspaceDelete } from './useWorkspaceDelete.js'
import { useWorkspaceSelection } from './useWorkspaceSelection.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'
import { useWorkerActions } from './worker/useWorkerActions.js'
import { AddWorkspaceDialog } from './workspace/AddWorkspaceDialog.js'

export const App = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const { activeWorkspaceId, selectWorkspace, setActiveWorkspaceId } = useWorkspaceSelection()
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(activeWorkspaceId)
  const [addDialogTrigger, setAddDialogTrigger] = useState(0)
  const [taskGraphOpen, setTaskGraphOpen] = useState(false)

  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId)

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

  const activeWorkspace = workspaces?.find((workspace) => workspace.id === activeWorkspaceId)
  const activeTasksFile = useTasksFile(activeWorkspaceId)
  const activeWorkers: TeamListItem[] = activeWorkspace
    ? (workersByWorkspaceId[activeWorkspace.id] ?? [])
    : []
  const rawTerminalRuns = useTerminalRuns(activeWorkspaceId)
  const terminalRunOptimism = useOptimisticTerminalRuns(activeWorkspaceId, rawTerminalRuns)
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
    <AppProviders>
      <MainLayout
        onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
        sidebar={
          <Sidebar
            activeWorkspaceId={activeWorkspaceId}
            onCreateClick={() => setAddDialogTrigger((value) => value + 1)}
            onDeleteWorkspace={deleteWorkspace}
            onSelectWorkspace={selectWorkspace}
            workersByWorkspaceId={workersByWorkspaceId}
            workspaces={workspaces}
          />
        }
        taskGraphOpen={taskGraphOpen}
      >
        {activeWorkspace ? (
          <WorkspaceTerminalPanels
            key={`terminal-${activeWorkspace.id}`}
            optimisticRuns={
              terminalRunOptimism.optimisticRunsByWorkspaceId[activeWorkspace.id] ?? []
            }
            workspaceId={activeWorkspace.id}
          />
        ) : null}
        <WorkspaceDetail
          onCreateWorker={workerActions.createWorker}
          onDeleteWorker={workerActions.deleteWorker}
          onStartWorker={workerActions.startWorker}
          onOrchestratorResult={recordOrchestratorResult}
          orchestratorAutostartError={
            activeWorkspace ? (orchestratorAutostartErrors[activeWorkspace.id] ?? null) : null
          }
          orchestratorAutostartRunId={
            activeWorkspace ? (orchestratorAutostartRunIds[activeWorkspace.id] ?? null) : null
          }
          terminalRuns={terminalRuns}
          workers={activeWorkers}
          workspace={activeWorkspace}
        />
        {activeWorkspace ? (
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
            workspacePath={activeWorkspace.path}
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
    </AppProviders>
  )
}
