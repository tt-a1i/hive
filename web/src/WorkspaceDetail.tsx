import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { listTerminalRuns, type TerminalRunSummary } from './api.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { TerminalView } from './terminal/TerminalView.js'

type WorkspaceDetailProps = {
  workspace: WorkspaceSummary | undefined
  workers: TeamListItem[]
  workerName: string
  workerRole: WorkerRole
  onTasksSubmit: (event: FormEvent<HTMLFormElement>) => void
  onWorkerNameChange: (value: string) => void
  onWorkerRoleChange: (value: WorkerRole) => void
  onWorkerSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export const WorkspaceDetail = ({
  workspace,
  workers,
  workerName,
  workerRole,
  onTasksSubmit,
  onWorkerNameChange,
  onWorkerRoleChange,
  onWorkerSubmit,
}: WorkspaceDetailProps) => {
  const [terminalRuns, setTerminalRuns] = useState<TerminalRunSummary[]>([])
  const workspaceId = workspace?.id ?? null
  const tasksFile = useTasksFile(workspaceId)

  useEffect(() => {
    if (!workspaceId) {
      setTerminalRuns([])
      return
    }
    let cancelled = false
    void listTerminalRuns(workspaceId)
      .then((runs) => {
        if (!cancelled) setTerminalRuns(runs)
      })
      .catch(() => {
        if (!cancelled) setTerminalRuns([])
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

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
      <form onSubmit={onWorkerSubmit}>
        <div>
          <label>
            Worker Name
            <input
              value={workerName}
              onChange={(event) => onWorkerNameChange(event.target.value)}
            />
          </label>
        </div>
        <div>
          <label>
            Worker Role
            <input
              value={workerRole}
              onChange={(event) => onWorkerRoleChange(event.target.value as WorkerRole)}
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

      {terminalRuns.map((run) => (
        <TerminalView
          key={run.run_id}
          runId={run.run_id}
          title={`${run.agent_name} (${run.status})`}
        />
      ))}
    </section>
  )
}
