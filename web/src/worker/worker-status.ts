import type { TeamListItem } from '../../../src/shared/types.js'

/** spec §3.6 三态 — 协议唯一事实，UI 不再增加合成状态 */
export type WorkerStatusKind = 'working' | 'idle' | 'stopped'

export interface WorkerStatusPresentation {
  kind: WorkerStatusKind
  label: string
  dotClass: string
  tone: string
}

export const presentWorkerStatus = (worker: TeamListItem): WorkerStatusPresentation => {
  if (worker.status === 'working') {
    return {
      kind: 'working',
      label: 'working',
      dotClass: 'status-dot status-dot--working',
      tone: 'var(--status-green)',
    }
  }
  if (worker.status === 'stopped') {
    return {
      kind: 'stopped',
      label: 'stopped',
      dotClass: 'status-dot status-dot--stopped',
      tone: 'var(--status-red)',
    }
  }
  return {
    kind: 'idle',
    label: 'idle',
    dotClass: 'status-dot status-dot--idle',
    tone: 'var(--text-tertiary)',
  }
}

/**
 * Queue length is a separate axis from status (spec §3.6.4). Surface it as
 * an independent badge — never as a status replacement.
 */
export interface WorkerQueueIndicator {
  count: number
  label: string
}

export const presentWorkerQueue = (worker: TeamListItem): WorkerQueueIndicator | null => {
  if (worker.pendingTaskCount <= 0) return null
  return {
    count: worker.pendingTaskCount,
    label: `${worker.pendingTaskCount} queued`,
  }
}
