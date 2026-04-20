import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { createWorker, createWorkspace, listWorkers, saveActiveWorkspaceId } from './api.js'
import { MainLayout } from './layout/MainLayout.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceForm } from './WorkspaceForm.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'

export const App = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([])
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false)
  const activeWorkspaceSaveQueue = useRef(Promise.resolve())

  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId)

  useEffect(() => {
    if (!activeWorkspaceId) return
    setMountedWorkspaceIds((current) =>
      current.includes(activeWorkspaceId) ? current : [...current, activeWorkspaceId]
    )
  }, [activeWorkspaceId])

  useEffect(() => {
    if (!activeWorkspaceId || workersByWorkspaceId[activeWorkspaceId]) {
      return
    }
    let cancelled = false
    void listWorkers(activeWorkspaceId)
      .then((items) => {
        if (!cancelled) {
          setWorkersByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: items }))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkersByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: [] }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, workersByWorkspaceId])

  const activeWorkspace = workspaces?.find((workspace) => workspace.id === activeWorkspaceId)

  const selectWorkspace = (workspaceId: string | null) => {
    setActiveWorkspaceId(workspaceId)
    activeWorkspaceSaveQueue.current = activeWorkspaceSaveQueue.current
      .catch(() => {})
      .then(() => saveActiveWorkspaceId(workspaceId))
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
    if (!activeWorkspaceId) {
      return
    }
    void createWorker(activeWorkspaceId, { name: workerName, role: workerRole }).then((worker) => {
      setWorkersByWorkspaceId((current) => ({
        ...current,
        [activeWorkspaceId]: [...(current[activeWorkspaceId] ?? []), worker],
      }))
    })
  }

  const handleTasksSubmit = (event: FormEvent<HTMLFormElement>) => event.preventDefault()

  return (
    <MainLayout
      sidebar={
        <Sidebar
          activeWorkspaceId={activeWorkspaceId}
          workspaces={workspaces}
          onCreateClick={() => setShowWorkspaceForm(true)}
          onSelectWorkspace={selectWorkspace}
        />
      }
    >
      {showWorkspaceForm || !activeWorkspace ? (
        <WorkspaceForm
          name={name}
          path={path}
          onNameChange={setName}
          onPathChange={setPath}
          onSubmit={handleSubmit}
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
        workspace={activeWorkspace}
        workers={activeWorkspace ? (workersByWorkspaceId[activeWorkspace.id] ?? []) : []}
        onCreateWorker={handleCreateWorker}
        onTasksSubmit={handleTasksSubmit}
      />
    </MainLayout>
  )
}
