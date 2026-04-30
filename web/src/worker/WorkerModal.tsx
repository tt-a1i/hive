import * as Dialog from '@radix-ui/react-dialog'
import { Copy, Play, RotateCcw, Square, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { Confirm } from '../ui/Confirm.js'
import { RoleAvatar } from './RoleAvatar.js'
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

const copyToClipboard = (value: string): Promise<boolean> => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard
      .writeText(value)
      .then(() => true)
      .catch((error: unknown) => {
        console.error('[hive] swallowed:WorkerModal.clipboard', error)
        return false
      })
  }
  return Promise.resolve(false)
}

type PendingConfirm = 'stop' | 'restart' | 'delete' | null

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
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null)
  const [pendingAction, setPendingAction] = useState<'stop' | 'restart' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)

  const role = getRolePresentation(worker.role)
  const status = presentWorkerStatus(worker)
  const queue = presentWorkerQueue(worker)
  const ptyRunning = !!runId
  const startBusy = starting
  const stopBusy = pendingAction === 'stop'
  const restartBusy = pendingAction === 'restart'
  const headerError = actionError || startError

  const dispatchStop = () => {
    if (!runId) return
    setPendingAction('stop')
    setActionError(null)
    void onStop(runId)
      .then(({ error }) => {
        if (error) setActionError(error)
      })
      .finally(() => setPendingAction(null))
  }

  const dispatchRestart = () => {
    if (!runId) {
      onStart(worker)
      return
    }
    setPendingAction('restart')
    setActionError(null)
    void onRestart(worker, runId)
      .then(({ error }) => {
        if (error) setActionError(error)
      })
      .finally(() => setPendingAction(null))
  }

  const handleCopyId = () => {
    void copyToClipboard(worker.id).then((ok) => {
      setCopyHint(ok ? 'Copied agent id' : 'Copy unavailable')
      window.setTimeout(() => setCopyHint(null), 1500)
    })
  }

  const closeConfirm = () => setPendingConfirm(null)

  const onConfirmAction = () => {
    if (pendingConfirm === 'stop') dispatchStop()
    if (pendingConfirm === 'restart') dispatchRestart()
    if (pendingConfirm === 'delete') onDelete(worker)
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose()
  }

  return (
    <Dialog.Root open onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="worker-modal-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <Dialog.Content
          data-testid="worker-modal"
          aria-label={`${worker.name} detail`}
          className="elev-2 fixed inset-y-0 right-0 z-50 flex w-[860px] max-w-[calc(100vw-32px)] flex-col border-l"
          style={{
            background: 'var(--bg-1)',
            borderColor: 'var(--border)',
          }}
        >
          <div
            className="flex shrink-0 items-center gap-3 border-b px-5 py-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <RoleAvatar role={worker.role} size={36} />
            <div className="min-w-0">
              <Dialog.Title className="truncate text-md font-medium text-pri">
                {worker.name}
              </Dialog.Title>
              <Dialog.Description className="mono truncate text-[11px] text-ter">
                {role.label} · {worker.role}
              </Dialog.Description>
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
                    onClick={() => setPendingConfirm('stop')}
                    disabled={stopBusy || restartBusy}
                    className="icon-btn"
                    data-testid="worker-stop"
                  >
                    <Square size={12} aria-hidden /> {stopBusy ? 'Stopping…' : 'Stop'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingConfirm('restart')}
                    disabled={stopBusy || restartBusy}
                    className="icon-btn"
                    data-testid="worker-restart"
                  >
                    <RotateCcw size={12} aria-hidden /> {restartBusy ? 'Restarting…' : 'Restart'}
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
                  <Play size={12} aria-hidden /> {startBusy ? 'Starting…' : 'Start'}
                </button>
              )}
              <button
                type="button"
                onClick={handleCopyId}
                className="icon-btn"
                title={copyHint ?? `Copy ${worker.id}`}
                data-testid="worker-copy-id"
              >
                <Copy size={12} aria-hidden /> Copy id
              </button>
              <button
                type="button"
                onClick={() => setPendingConfirm('delete')}
                className="icon-btn icon-btn--danger"
                data-testid="worker-delete"
              >
                <Trash2 size={12} aria-hidden /> Delete
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close worker detail"
                  className="ml-1 flex h-7 w-7 items-center justify-center rounded text-sec hover:bg-3 hover:text-pri"
                >
                  <X size={14} aria-hidden />
                </button>
              </Dialog.Close>
            </div>
          </div>

          {headerError ? (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-b px-5 py-2 text-[11px]"
              style={{
                background: 'color-mix(in oklab, var(--status-red) 10%, transparent)',
                borderColor: 'color-mix(in oklab, var(--status-red) 30%, var(--border))',
                color: 'var(--status-red)',
              }}
            >
              <span aria-hidden>⚠</span>
              <span className="break-words">{headerError}</span>
            </div>
          ) : null}

          <div
            className="flex min-h-0 flex-1 flex-col p-3"
            style={{ background: 'var(--bg-1)' }}
            data-testid="worker-modal-terminal-slot"
          >
            <div
              className="flex min-h-0 flex-1 rounded-lg border"
              style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
            >
              {ptyRunning ? (
                <div
                  id={`worker-pty-${runId}`}
                  className="flex h-full w-full"
                  data-pty-slot="worker"
                />
              ) : (
                <div className="m-auto flex max-w-[400px] flex-col items-center gap-3 px-6 text-center">
                  <RoleAvatar role={worker.role} size={48} />
                  <div className="text-sm text-pri">
                    {worker.status === 'stopped' ? 'PTY stopped' : 'PTY not started yet'}
                  </div>
                  <div className="text-[11px] leading-snug text-ter">
                    {worker.pendingTaskCount > 0
                      ? `${worker.pendingTaskCount} pending task(s) will resume after restart.`
                      : 'Start the agent to begin receiving dispatches.'}
                  </div>
                  <button
                    type="button"
                    onClick={() => onStart(worker)}
                    disabled={startBusy}
                    className="icon-btn icon-btn--primary"
                    data-testid="worker-start-empty"
                  >
                    <Play size={12} aria-hidden /> {startBusy ? 'Starting…' : 'Start'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div
            className="flex shrink-0 items-center gap-3 border-t px-5 py-2 text-[11px] text-ter"
            style={{ borderColor: 'var(--border)' }}
          >
            <span>
              agent id <span className="mono text-sec">{worker.id}</span>
            </span>
            <span aria-hidden>·</span>
            <span>
              queue <span className="mono text-sec">{worker.pendingTaskCount}</span>
            </span>
            {copyHint ? <span className="ml-auto text-[10px] text-sec">{copyHint}</span> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      <Confirm
        open={pendingConfirm === 'stop'}
        onOpenChange={(open) => !open && closeConfirm()}
        title={`Stop ${worker.name}?`}
        description="The PTY will be killed; any in-flight work in this terminal will be lost. Pending dispatches stay queued."
        confirmLabel="Stop"
        confirmKind="danger"
        onConfirm={onConfirmAction}
      />
      <Confirm
        open={pendingConfirm === 'restart'}
        onOpenChange={(open) => !open && closeConfirm()}
        title={`Restart ${worker.name}?`}
        description="The current PTY will be killed and a new one started. Useful when the agent is hung."
        confirmLabel="Restart"
        onConfirm={onConfirmAction}
      />
      <Confirm
        open={pendingConfirm === 'delete'}
        onOpenChange={(open) => !open && closeConfirm()}
        title={`Delete ${worker.name}?`}
        description="This stops the agent's terminal and removes it from the workspace. All queued dispatches are dropped."
        confirmLabel="Delete member"
        confirmKind="danger"
        onConfirm={onConfirmAction}
      />
    </Dialog.Root>
  )
}
