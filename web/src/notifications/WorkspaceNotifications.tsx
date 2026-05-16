import { useEffect, useRef } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../../src/shared/types.js'
import type { TerminalRunSummary } from '../api.js'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { useNotifications } from './NotificationProvider.js'

const ROLE_LABEL_KEYS: Record<WorkerRole, TranslationKey> = {
  coder: 'role.coder',
  custom: 'role.custom',
  reviewer: 'role.reviewer',
  tester: 'role.tester',
}

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
  const { t } = useI18n()
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
          brief: t('notifications.workerStopped.brief', { name: worker.name }),
          detail: t('notifications.workerStopped.detail', {
            name: worker.name,
            workspace: workspace.name,
            count: worker.pendingTaskCount,
          }),
          kind: 'error',
          title: t('notifications.workerStopped.title'),
        })
        continue
      }

      if (before.status === 'stopped' && worker.status !== 'stopped') {
        notify({
          brief: t('notifications.workerStarted.brief', { name: worker.name }),
          detail: t('notifications.workerStarted.detail', {
            name: worker.name,
            workspace: workspace.name,
            role: t(ROLE_LABEL_KEYS[worker.role]),
          }),
          kind: 'success',
          title: t('notifications.workerStarted.title'),
        })
        continue
      }

      const completedTask =
        worker.pendingTaskCount < before.pendingTaskCount ||
        (before.status === 'working' && worker.status === 'idle')
      if (completedTask) {
        notify({
          brief: t('notifications.workerReported.brief', { name: worker.name }),
          detail: t('notifications.workerReported.detail', {
            name: worker.name,
            workspace: workspace.name,
            count: worker.pendingTaskCount,
          }),
          kind: 'success',
          title: t('notifications.workerReported.title'),
        })
      }
    }
  }, [notify, t, workers, workspace])

  return null
}
