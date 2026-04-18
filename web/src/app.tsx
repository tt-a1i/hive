import { useEffect, useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { createWorker, createWorkspace, listWorkers, listWorkspaces } from './api.js'

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

  useEffect(() => {
    let cancelled = false

    void listWorkspaces().then((items) => {
      if (!cancelled) {
        setWorkspaces(items)
        setActiveWorkspaceId(items[0]?.id ?? null)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeWorkspaceId || workersByWorkspaceId[activeWorkspaceId]) {
      return
    }

    let cancelled = false

    void listWorkers(activeWorkspaceId).then((items) => {
      if (!cancelled) {
        setWorkersByWorkspaceId((current) => ({ ...current, [activeWorkspaceId]: items }))
      }
    })

    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, workersByWorkspaceId])

  const activeWorkspace = workspaces?.find((workspace) => workspace.id === activeWorkspaceId)
  const activeWorkers = activeWorkspaceId ? (workersByWorkspaceId[activeWorkspaceId] ?? []) : []

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    void createWorkspace({ name, path }).then((workspace) => {
      setWorkspaces((current) => (current === null ? [workspace] : [...current, workspace]))
      setActiveWorkspaceId(workspace.id)
      setWorkersByWorkspaceId((current) => ({ ...current, [workspace.id]: [] }))
      setName('')
      setPath('')
    })
  }

  const handleWorkerSubmit = (event: React.FormEvent<HTMLFormElement>) => {
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

  return (
    <main>
      <h1>Hive</h1>

      {workspaces !== null && workspaces.length > 0 ? (
        <ul aria-label="Workspaces">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <button type="button" onClick={() => setActiveWorkspaceId(workspace.id)}>
                {workspace.name}
              </button>
            </li>
          ))}
        </ul>
      ) : workspaces !== null ? (
        <p>No workspaces yet</p>
      ) : null}

      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Workspace Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Workspace Path
            <input value={path} onChange={(event) => setPath(event.target.value)} />
          </label>
        </div>
        <button type="submit">Create Workspace</button>
      </form>

      {activeWorkspace ? (
        <section>
          <p>{activeWorkspace.path}</p>
          <h3>Orchestrator</h3>
          <form onSubmit={handleWorkerSubmit}>
            <div>
              <label>
                Worker Name
                <input value={workerName} onChange={(event) => setWorkerName(event.target.value)} />
              </label>
            </div>
            <div>
              <label>
                Worker Role
                <input
                  value={workerRole}
                  onChange={(event) => setWorkerRole(event.target.value as WorkerRole)}
                />
              </label>
            </div>
            <button type="submit">Add Worker</button>
          </form>

          {activeWorkers.length > 0 ? (
            <ul aria-label="Workers">
              {activeWorkers.map((worker) => (
                <li key={worker.id}>
                  <span>{worker.name}</span> <span>{worker.role}</span> <span>{worker.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>Worker cards coming next</p>
          )}
        </section>
      ) : null}
    </main>
  )
}
