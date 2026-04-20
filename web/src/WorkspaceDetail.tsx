import type { FormEvent } from 'react'
import { useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { useTasksFile } from './tasks/useTasksFile.js'

type WorkspaceDetailProps = {
  onCreateWorker: (name: string, role: WorkerRole) => void
  workspace: WorkspaceSummary | undefined
  workers: TeamListItem[]
  onTasksSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export const WorkspaceDetail = ({
  onCreateWorker,
  workspace,
  workers,
  onTasksSubmit,
}: WorkspaceDetailProps) => {
  const [workerName, setWorkerName] = useState('')
  const [workerRole, setWorkerRole] = useState<WorkerRole>('coder')
  const workspaceId = workspace?.id ?? null
  const tasksFile = useTasksFile(workspaceId)

  if (!workspace) {
    return null
  }

  return (
    <section>
      <p>{workspace.path}</p>
      {tasksFile.loaded ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void tasksFile.onSave().then(() => onTasksSubmit(event))
          }}
        >
          <div>
            <label>
              Tasks Markdown
              <textarea
                value={tasksFile.content}
                onChange={(event) => tasksFile.onChange(event.target.value)}
              />
            </label>
          </div>
          {tasksFile.hasConflict ? (
            <div>
              <p>文件已在外部变化</p>
              <button type="button" onClick={tasksFile.onReload}>
                Reload
              </button>
              <button type="button" onClick={tasksFile.onKeepLocal}>
                Keep Local
              </button>
            </div>
          ) : null}
          <button type="submit">Save Tasks</button>
        </form>
      ) : null}
      <h3>Orchestrator</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onCreateWorker(workerName, workerRole)
          setWorkerName('')
          setWorkerRole('coder')
        }}
      >
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

      {workers.length > 0 ? (
        <ul aria-label="Workers">
          {workers.map((worker) => (
            <li key={worker.id}>
              <span>{worker.name}</span> <span>{worker.role}</span> <span>{worker.status}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>Worker cards coming next</p>
      )}
    </section>
  )
}
