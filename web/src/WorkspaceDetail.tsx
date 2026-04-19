import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { listTerminalRuns, type TerminalRunSummary } from './api.js'
import { TerminalView } from './terminal/TerminalView.js'

type WorkspaceDetailProps = {
  workspace: WorkspaceSummary | undefined
  tasksLoaded: boolean
  tasks: string
  workers: TeamListItem[]
  workerName: string
  workerRole: WorkerRole
  onTasksChange: (value: string) => void
  onTasksSubmit: (event: FormEvent<HTMLFormElement>) => void
  onWorkerNameChange: (value: string) => void
  onWorkerRoleChange: (value: WorkerRole) => void
  onWorkerSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export const WorkspaceDetail = ({
  workspace,
  tasksLoaded,
  tasks,
  workers,
  workerName,
  workerRole,
  onTasksChange,
  onTasksSubmit,
  onWorkerNameChange,
  onWorkerRoleChange,
  onWorkerSubmit,
}: WorkspaceDetailProps) => {
  const [terminalRuns, setTerminalRuns] = useState<TerminalRunSummary[]>([])
  const workspaceId = workspace?.id ?? null

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
      {tasksLoaded ? (
        <form onSubmit={onTasksSubmit}>
          <div>
            <label>
              Tasks Markdown
              <textarea value={tasks} onChange={(event) => onTasksChange(event.target.value)} />
            </label>
          </div>
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
