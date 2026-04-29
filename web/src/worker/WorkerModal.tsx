import { useEffect, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { getRolePresentation } from './role-presentation.js'
import { presentWorkerQueue, presentWorkerStatus } from './worker-status.js'

type WorkerModalProps = {
  onClose: () => void
  onDelete: (worker: TeamListItem) => void
  onStart: (worker: TeamListItem) => void
  onStop: (runId: string) => Promise<{ error: string | null }>
  onRestart: (worker: TeamListItem, runId: string) => Promise<{ error: string | null }>
  runId: string | null
  startError: string | null
  starting: boolean
  worker: TeamListItem
}

const copyToClipboard = (value: string) => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value).catch(() => {})
  }
}

export const WorkerModal = ({
  onClose,
  onDelete,
  onStart,
  onStop,
  onRestart,
  runId,
  startError,
  starting,
  worker,
}: WorkerModalProps) => {
  const [pendingAction, setPendingAction] = useState<'stop' | 'restart' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const role = getRolePresentation(worker.role)
  const status = presentWorkerStatus(worker)
  const queue = presentWorkerQueue(worker)

  const handleStop = () => {
    if (!runId) return
    const confirmed = window.confirm(
      `Stop ${worker.name}? The PTY will be killed; any in-flight work in this terminal will be lost. Pending dispatches stay queued.`
    )
    if (!confirmed) return
    setPendingAction('stop')
    setActionError(null)
    void onStop(runId)
      .then(({ error }) => {
        if (error) setActionError(error)
      })
      .finally(() => setPendingAction(null))
  }

  const handleRestart = () => {
    if (!runId) {
      onStart(worker)
      return
    }
    const confirmed = window.confirm(
      `Restart ${worker.name}? The current PTY will be killed and a new one started. Useful when the agent is hung.`
    )
    if (!confirmed) return
    setPendingAction('restart')
    setActionError(null)
    void onRestart(worker, runId)
      .then(({ error }) => {
        if (error) setActionError(error)
      })
      .finally(() => setPendingAction(null))
  }

  const handleCopyId = () => {
    copyToClipboard(worker.id)
    setCopyHint('Copied agent id')
    window.setTimeout(() => setCopyHint(null), 1500)
  }

  const handleDelete = () => {
    const confirmed = window.confirm(
      `Delete team member "${worker.name}"? This will stop its terminal and remove all queued tasks.`
    )
    if (!confirmed) return
    onDelete(worker)
  }

  const ptyRunning = !!runId
  const startBusy = starting
  const stopBusy = pendingAction === 'stop'
  const restartBusy = pendingAction === 'restart'
  const headerError = actionError || startError

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
          <div className="min-w-0">
            <div className="truncate font-medium text-pri">{worker.name}</div>
            <div className="mono truncate text-[11px] text-ter">
              {role.label} · {worker.role}
            </div>
          </div>
          <span className={`status-pill status-pill--${status.kind}`} role="status">
            <span className={status.dotClass} aria-hidden />
            {status.label}
          </span>
          {queue ? (
            <span className="queue-badge" title="pending dispatches — independent of PTY state">
              <span className="status-dot status-dot--queued" aria-hidden />
              {queue.label}
            </span>
          ) : null}
          <div className="flex-1" />

          <div className="flex items-center gap-1.5" data-testid="worker-modal-actions">
            {ptyRunning ? (
              <>
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={stopBusy || restartBusy}
                  className="icon-btn"
                  data-testid="worker-stop"
                >
                  <span aria-hidden>⏹</span> {stopBusy ? 'Stopping…' : 'Stop'}
                </button>
                <button
                  type="button"
                  onClick={handleRestart}
                  disabled={stopBusy || restartBusy}
                  className="icon-btn"
                  data-testid="worker-restart"
                >
                  <span aria-hidden>↻</span> {restartBusy ? 'Restarting…' : 'Restart'}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => onStart(worker)}
                disabled={startBusy}
                className="icon-btn icon-btn--primary"
                data-testid="worker-start"
              >
                <span aria-hidden>▶</span> {startBusy ? 'Starting…' : 'Start'}
              </button>
            )}
            <button
              type="button"
              onClick={handleCopyId}
              className="icon-btn"
              title={copyHint ?? `Copy ${worker.id}`}
              data-testid="worker-copy-id"
            >
              <span aria-hidden>⧉</span> Copy id
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="icon-btn icon-btn--danger"
              data-testid="worker-delete"
            >
              <span aria-hidden>🗑</span> Delete
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
        </div>

        {headerError ? (
          <p
            role="alert"
            className="border-b border-status-red/30 bg-status-red/10 px-4 py-1.5 text-[11px] text-status-red"
          >
            {headerError}
          </p>
        ) : null}

        <div
          className="flex min-h-0 flex-1 flex-col p-2"
          style={{ background: 'var(--bg-1)' }}
          data-testid="worker-modal-terminal-slot"
        >
          <div
            className="flex min-h-0 flex-1 rounded border"
            style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
          >
            {ptyRunning ? (
              <div
                id={`worker-pty-${runId}`}
                className="flex h-full w-full"
                data-pty-slot="worker"
              />
            ) : (
              <div className="m-auto flex max-w-[360px] flex-col items-center gap-3 px-6 text-center text-xs text-ter">
                <div className="text-sm text-sec">PTY not running</div>
                <div className="text-[11px] text-ter">
                  Terminal is {worker.status === 'stopped' ? 'stopped' : 'not started yet'}.
                  {worker.pendingTaskCount > 0
                    ? ` ${worker.pendingTaskCount} pending task(s) will resume after restart.`
                    : ''}
                </div>
                <button
                  type="button"
                  onClick={() => onStart(worker)}
                  disabled={startBusy}
                  className="icon-btn icon-btn--primary"
                  data-testid="worker-start-empty"
                >
                  <span aria-hidden>▶</span> {startBusy ? 'Starting…' : 'Start'}
                </button>
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
          {copyHint ? <span className="ml-auto text-[10px] text-sec">{copyHint}</span> : null}
        </div>
      </div>
    </div>
  )
}
