import { useEffect, useRef, useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import { saveActiveWorkspaceId } from './api.js'
import { MainLayout } from './layout/MainLayout.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { TaskGraphDrawer } from './tasks/TaskGraphDrawer.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { useTerminalRuns } from './terminal/useTerminalRuns.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useWorkspaceCreate } from './useWorkspaceCreate.js'
import { useWorkspaceStats } from './useWorkspaceStats.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'
import { useWorkerActions } from './worker/useWorkerActions.js'
import { AddWorkspaceDialog } from './workspace/AddWorkspaceDialog.js'

const RUNTIME_ADDRESS = '127.0.0.1:4010'
const HIVE_PORT = '4010'

export const App = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(activeWorkspaceId)
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([])
  const [addDialogTrigger, setAddDialogTrigger] = useState(0)
  const [taskGraphOpen, setTaskGraphOpen] = useState(false)
  const activeWorkspaceSaveQueue = useRef(Promise.resolve())

  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId)

  const selectWorkspace = (workspaceId: string | null) => {
    setActiveWorkspaceId(workspaceId)
    activeWorkspaceSaveQueue.current = activeWorkspaceSaveQueue.current
      .catch(() => {})
      .then(() => saveActiveWorkspaceId(workspaceId))
      .catch(() => {})
  }

  const { orchestratorAutostartErrors, recordOrchestratorResult, createNewWorkspace } =
    useWorkspaceCreate({
      hivePort: HIVE_PORT,
      onWorkspaceCreated: (workspace) => {
        setWorkspaces((current) => (current === null ? [workspace] : [...current, workspace]))
        selectWorkspace(workspace.id)
        setWorkersByWorkspaceId((current) => ({ ...current, [workspace.id]: [] }))
      },
    })

  useEffect(() => {
    if (!activeWorkspaceId) return
    setMountedWorkspaceIds((current) =>
      current.includes(activeWorkspaceId) ? current : [...current, activeWorkspaceId]
    )
  }, [activeWorkspaceId])

  // Auto-open the picker on empty-state so the user is never stuck at a blank
  // canvas. The dialog itself fires the native OS folder picker on trigger
  // change; setting the trigger once per empty-state detection is enough.
  const emptyStateTriggeredRef = useRef(false)
  useEffect(() => {
    if (workspaces === null) return
    if (workspaces.length === 0 && !emptyStateTriggeredRef.current) {
      emptyStateTriggeredRef.current = true
      setAddDialogTrigger((value) => value + 1)
    }
  }, [workspaces])

  const activeWorkspace = workspaces?.find((workspace) => workspace.id === activeWorkspaceId)
  const activeTasksFile = useTasksFile(activeWorkspaceId)
  const activeWorkers: TeamListItem[] = activeWorkspace
    ? (workersByWorkspaceId[activeWorkspace.id] ?? [])
    : []
  const terminalRuns = useTerminalRuns(activeWorkspaceId)
  const stats = useWorkspaceStats(activeWorkspaceId, activeWorkers, terminalRuns)
  const workerActions = useWorkerActions({
    activeWorkspaceId,
    hivePort: HIVE_PORT,
    setWorkersByWorkspaceId,
  })

  return (
    <MainLayout
      onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
      running={stats.working + stats.idle}
      runtimeAddress={RUNTIME_ADDRESS}
      sidebar={
        <Sidebar
          activeWorkspaceId={activeWorkspaceId}
          onCreateClick={() => setAddDialogTrigger((value) => value + 1)}
          onSelectWorkspace={selectWorkspace}
          workersByWorkspaceId={workersByWorkspaceId}
          workspaces={workspaces}
        />
      }
      stopped={stats.stopped}
      taskGraphOpen={taskGraphOpen}
      workspaceCount={workspaces?.length ?? 0}
    >
      {workspaces
        ?.filter((workspace) => mountedWorkspaceIds.includes(workspace.id))
        .map((workspace) => (
          <WorkspaceTerminalPanels
            key={`terminal-${workspace.id}`}
            hidden={workspace.id !== activeWorkspaceId}
            workspaceId={workspace.id}
          />
        ))}
      <WorkspaceDetail
        hivePort={HIVE_PORT}
        onCreateWorker={workerActions.createWorker}
        onDeleteWorker={workerActions.deleteWorker}
        onStartWorker={workerActions.startWorker}
        onStopWorkerRun={workerActions.stopWorkerRun}
        onOrchestratorResult={recordOrchestratorResult}
        orchestratorAutostartError={
          activeWorkspace ? (orchestratorAutostartErrors[activeWorkspace.id] ?? null) : null
        }
        stats={stats}
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
            void activeTasksFile.toggleTaskAtLine(line).catch(() => {})
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
  )
}
