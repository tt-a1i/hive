import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import {
  createWorker,
  createWorkspace,
  getWorkspaceTasks,
  listWorkers,
  saveWorkspaceTasks,
} from './api.js'
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
  const [tasksByWorkspaceId, setTasksByWorkspaceId] = useState<Record<string, string>>({})
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

  useEffect(() => {
    if (!activeWorkspaceId || tasksByWorkspaceId[activeWorkspaceId] !== undefined) {
      return
    }
    let cancelled = false
    void getWorkspaceTasks(activeWorkspaceId)
      .then(({ content }) => {
        if (!cancelled) {
          setTasksByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: content }))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTasksByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: '' }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, tasksByWorkspaceId])

  const activeWorkspace = workspaces?.find((workspace) => workspace.id === activeWorkspaceId)
  const activeWorkers = activeWorkspaceId ? (workersByWorkspaceId[activeWorkspaceId] ?? []) : []
  const activeTasksLoaded = activeWorkspaceId
    ? tasksByWorkspaceId[activeWorkspaceId] !== undefined
    : false
  const activeTasks = activeWorkspaceId ? (tasksByWorkspaceId[activeWorkspaceId] ?? '') : ''

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void createWorkspace({ name, path }).then((workspace) => {
      setWorkspaces((current) => (current === null ? [workspace] : [...current, workspace]))
      setActiveWorkspaceId(workspace.id)
      setWorkersByWorkspaceId((current) => ({ ...current, [workspace.id]: [] }))
      setTasksByWorkspaceId((current) => ({ ...current, [workspace.id]: '' }))
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

  const handleTasksSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeWorkspaceId) return
    void saveWorkspaceTasks(activeWorkspaceId, { content: activeTasks }).then(({ content }) => {
      setTasksByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: content }))
    })
  }

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
        tasksLoaded={activeTasksLoaded}
        tasks={activeTasks}
        workers={activeWorkers}
        workerName={workerName}
        workerRole={workerRole}
        onTasksChange={(value) =>
          activeWorkspace &&
          setTasksByWorkspaceId((current) => ({ ...current, [activeWorkspace.id]: value }))
        }
        onTasksSubmit={handleTasksSubmit}
        onWorkerNameChange={setWorkerName}
        onWorkerRoleChange={setWorkerRole}
        onWorkerSubmit={handleWorkerSubmit}
      />
    </main>
  )
}
