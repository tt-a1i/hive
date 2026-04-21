import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'

import type { WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { createWorker, createWorkspace, saveActiveWorkspaceId } from './api.js'
import { MainLayout } from './layout/MainLayout.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { TaskGraphDrawer } from './tasks/TaskGraphDrawer.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceForm } from './WorkspaceForm.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'

const RUNTIME_ADDRESS = '127.0.0.1:4010'

export const App = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(activeWorkspaceId)
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([])
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false)
  const [taskGraphOpen, setTaskGraphOpen] = useState(true)
  const activeWorkspaceSaveQueue = useRef(Promise.resolve())

  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId)

  useEffect(() => {
    if (!activeWorkspaceId) return
    setMountedWorkspaceIds((current) =>
      current.includes(activeWorkspaceId) ? current : [...current, activeWorkspaceId]
    )
  }, [activeWorkspaceId])

  const activeWorkspace = workspaces?.find((workspace) => workspace.id === activeWorkspaceId)
  const activeTasksFile = useTasksFile(activeWorkspaceId)
  const activeWorkers = activeWorkspace ? (workersByWorkspaceId[activeWorkspace.id] ?? []) : []
  const agentsAlive =
    Object.values(workersByWorkspaceId).reduce(
      (total, list) => total + list.filter((worker) => worker.status !== 'stopped').length,
      0
    ) + (activeWorkspace ? 1 : 0)

  const selectWorkspace = (workspaceId: string | null) => {
    setActiveWorkspaceId(workspaceId)
    activeWorkspaceSaveQueue.current = activeWorkspaceSaveQueue.current
      .catch(() => {})
      .then(() => saveActiveWorkspaceId(workspaceId))
      .catch(() => {})
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void createWorkspace({ name, path }).then((workspace) => {
      setWorkspaces((current) => (current === null ? [workspace] : [...current, workspace]))
      selectWorkspace(workspace.id)
      setWorkersByWorkspaceId((current) => ({ ...current, [workspace.id]: [] }))
      setShowWorkspaceForm(false)
      setName('')
      setPath('')
    })
  }

  const handleCreateWorker = (workerName: string, workerRole: WorkerRole) => {
    if (!activeWorkspaceId) return
    void createWorker(activeWorkspaceId, { name: workerName, role: workerRole }).then((worker) => {
      setWorkersByWorkspaceId((current) => ({
        ...current,
        [activeWorkspaceId]: [...(current[activeWorkspaceId] ?? []), worker],
      }))
    })
  }

  return (
    <MainLayout
      agentsAlive={agentsAlive}
      onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
      runtimeAddress={RUNTIME_ADDRESS}
      sidebar={
        <Sidebar
          activeWorkspaceId={activeWorkspaceId}
          onCreateClick={() => setShowWorkspaceForm(true)}
          onSelectWorkspace={selectWorkspace}
          workersByWorkspaceId={workersByWorkspaceId}
          workspaces={workspaces}
        />
      }
      taskGraphOpen={taskGraphOpen}
      workspaceCount={workspaces?.length ?? 0}
    >
      {showWorkspaceForm || !activeWorkspace ? (
        <WorkspaceForm
          name={name}
          onNameChange={setName}
          onPathChange={setPath}
          onSubmit={handleSubmit}
          path={path}
        />
      ) : null}
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
        onCreateWorker={handleCreateWorker}
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
    </MainLayout>
  )
}
