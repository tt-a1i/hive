import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { createWorker, createWorkspace, listWorkers } from './api.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceForm } from './WorkspaceForm.js'
import { WorkspaceList } from './WorkspaceList.js'

export const App = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )
  const [workerName, setWorkerName] = useState('')
  const [workerRole, setWorkerRole] = useState<WorkerRole>('coder')

  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId)

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
  const activeWorkers = activeWorkspaceId ? (workersByWorkspaceId[activeWorkspaceId] ?? []) : []

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void createWorkspace({ name, path }).then((workspace) => {
      setWorkspaces((current) => (current === null ? [workspace] : [...current, workspace]))
      setActiveWorkspaceId(workspace.id)
      setWorkersByWorkspaceId((current) => ({ ...current, [workspace.id]: [] }))
      setName('')
      setPath('')
    })
  }

  const handleWorkerSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeWorkspaceId) {
      return
    }
    void createWorker(activeWorkspaceId, { name: workerName, role: workerRole }).then((worker) => {
      setWorkersByWorkspaceId((current) => ({
        ...current,
        [activeWorkspaceId]: [...(current[activeWorkspaceId] ?? []), worker],
      }))
      setWorkerName('')
      setWorkerRole('coder')
    })
  }

  const handleTasksSubmit = (event: FormEvent<HTMLFormElement>) => event.preventDefault()

  return (
    <main>
      <h1>Hive</h1>
      <WorkspaceList workspaces={workspaces} onSelect={setActiveWorkspaceId} />
      <WorkspaceForm
        name={name}
        path={path}
        onNameChange={setName}
        onPathChange={setPath}
        onSubmit={handleSubmit}
      />
      <WorkspaceDetail
        workspace={activeWorkspace}
        workers={activeWorkers}
        workerName={workerName}
        workerRole={workerRole}
        onTasksSubmit={handleTasksSubmit}
        onWorkerNameChange={setWorkerName}
        onWorkerRoleChange={setWorkerRole}
        onWorkerSubmit={handleWorkerSubmit}
      />
    </main>
  )
}
