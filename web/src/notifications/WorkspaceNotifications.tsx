import { useEffect, useRef } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'
import type { TerminalRunSummary } from '../api.js'
import { useNotifications } from './NotificationProvider.js'

type WorkerSnapshot = Pick<TeamListItem, 'id' | 'name' | 'pendingTaskCount' | 'role' | 'status'>

interface Snapshot {
  workers: Map<string, WorkerSnapshot>
  workspaceId: string
}

interface WorkspaceNotificationsProps {
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

const toWorkerMap = (workers: TeamListItem[]): Map<string, WorkerSnapshot> =>
  new Map(
    workers.map((worker) => [
      worker.id,
      {
        id: worker.id,
        name: worker.name,
        pendingTaskCount: worker.pendingTaskCount,
        role: worker.role,
        status: worker.status,
      },
    ])
  )

export const WorkspaceNotifications = ({
  terminalRuns: _terminalRuns,
  workers,
  workspace,
}: WorkspaceNotificationsProps) => {
  const { notify } = useNotifications()
  const previous = useRef<Snapshot | null>(null)

  useEffect(() => {
    if (!workspace) {
      previous.current = null
      return
    }

    const currentWorkers = toWorkerMap(workers)
    const prior = previous.current
    previous.current = { workers: currentWorkers, workspaceId: workspace.id }

    if (!prior || prior.workspaceId !== workspace.id) return

    for (const worker of currentWorkers.values()) {
      const before = prior.workers.get(worker.id)
      if (!before) continue

      if (before.status !== 'stopped' && worker.status === 'stopped') {
        notify({
          brief: `${worker.name} stopped`,
          detail: `${worker.name} stopped in ${workspace.name}; ${worker.pendingTaskCount} queued task(s) remain.`,
          kind: 'error',
          title: 'Team member stopped',
        })
        continue
      }

      if (before.status === 'stopped' && worker.status !== 'stopped') {
        notify({
          brief: `${worker.name} started`,
          detail: `${worker.name} started in ${workspace.name} as ${worker.role}.`,
          kind: 'success',
          title: 'Team member started',
        })
        continue
      }

      const completedTask =
        worker.pendingTaskCount < before.pendingTaskCount ||
        (before.status === 'working' && worker.status === 'idle')
      if (completedTask) {
        notify({
          brief: `${worker.name} reported`,
          detail: `${worker.name} reported in ${workspace.name}; ${worker.pendingTaskCount} queued task(s) remain.`,
          kind: 'success',
          title: 'Team member report',
        })
      }
    }
  }, [notify, workers, workspace])

  return null
}
