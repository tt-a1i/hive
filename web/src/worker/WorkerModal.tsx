import { useEffect } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { getRolePresentation } from './role-presentation.js'

type WorkerModalProps = {
  onClose: () => void
  runId: string | null
  worker: TeamListItem
}

export const WorkerModal = ({ onClose, runId, worker }: WorkerModalProps) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const role = getRolePresentation(worker.role)

  return (
    <div data-testid="worker-modal" className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close worker detail"
        onClick={onClose}
        className="modal-backdrop absolute inset-0"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${worker.name} detail`}
        className="relative flex flex-col rounded-lg border shadow-2xl"
        style={{
          width: '760px',
          height: '78vh',
          background: 'var(--bg-1)',
          borderColor: 'var(--border)',
        }}
      >
        <div
          className="flex shrink-0 items-center gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <span className="text-2xl leading-none" aria-hidden>
            {role.emoji}
          </span>
          <div>
            <div className="font-medium text-pri">{worker.name}</div>
            <div className="mono text-[11px] text-ter">
              {role.label} · {worker.status}
            </div>
          </div>
          <span className={`role-badge ${role.badgeClass}`}>{role.label}</span>
          <div className="flex-1" />
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
          >
            stop
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
          >
            restart
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close worker detail"
            className="px-2 text-lg leading-none text-sec hover:text-pri"
          >
            ×
          </button>
        </div>

        <div
          className="flex min-h-0 flex-1 flex-col p-2"
          style={{ background: 'var(--bg-1)' }}
          data-testid="worker-modal-terminal-slot"
        >
          <div
            className="flex min-h-0 flex-1 rounded border"
            style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
          >
            {runId ? (
              <div
                id={`worker-pty-${runId}`}
                className="flex h-full w-full"
                data-pty-slot="worker"
              />
            ) : (
              <div className="m-auto text-xs text-ter">
                PTY not running — start this agent to open a terminal.
              </div>
            )}
          </div>
        </div>

        <div
          className="flex shrink-0 items-center gap-3 border-t px-4 py-2 text-[11px] text-ter"
          style={{ borderColor: 'var(--border)' }}
        >
          <span>
            agent id: <span className="mono text-sec">{worker.id}</span>
          </span>
          <span aria-hidden>·</span>
          <span>
            queue: <span className="mono text-sec">{worker.pendingTaskCount}</span>
          </span>
        </div>
      </div>
    </div>
  )
}
