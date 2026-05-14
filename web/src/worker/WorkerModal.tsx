import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Play, X } from 'lucide-react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { RoleAvatar } from './RoleAvatar.js'
import { getRolePresentation } from './role-presentation.js'
import { useWorkerModalResize, WORKER_MODAL_MIN } from './useWorkerModalResize.js'
import { presentWorkerStatus } from './worker-status.js'

type WorkerModalProps = {
  onClose: () => void
  onStart: (worker: TeamListItem) => void
  runId: string | null
  startError: string | null
  starting: boolean
  worker: TeamListItem
}

/**
 * Worker detail dialog — pure PTY view. All control actions (Stop / Restart /
 * Delete / Start) live on the WorkerCard's hover cluster now; this dialog
 * only handles "watch the terminal" + "close". The empty-state Start button
 * is the lone exception so a stopped agent is restartable from inside.
 */
export const WorkerModal = ({
  onClose,
  onStart,
  runId,
  startError,
  starting,
  worker,
}: WorkerModalProps) => {
  const role = getRolePresentation(worker.role)
  const status = presentWorkerStatus(worker)
  const ptyRunning = !!runId
  const resize = useWorkerModalResize()

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
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center">
          <Dialog.Content
            data-testid="worker-modal"
            aria-label={`${worker.name} detail`}
            className="dialog-scale-pop pointer-events-auto relative flex h-screen max-h-screen max-w-full flex-col overflow-hidden"
            style={{
              background: 'var(--bg-1)',
              width: `${resize.width}px`,
            }}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: aria role="separator" is the canonical resize-handle role */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize worker detail width"
              aria-valuemin={WORKER_MODAL_MIN}
              aria-valuenow={Math.round(resize.width)}
              className="modal-resize-handle modal-resize-handle--left"
              tabIndex={-1}
              data-resizing={resize.resizing || undefined}
              onPointerDown={resize.beginResize('left')}
            />
            {/* biome-ignore lint/a11y/useSemanticElements: aria role="separator" is the canonical resize-handle role */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize worker detail width"
              aria-valuemin={WORKER_MODAL_MIN}
              aria-valuenow={Math.round(resize.width)}
              className="modal-resize-handle modal-resize-handle--right"
              tabIndex={-1}
              data-resizing={resize.resizing || undefined}
              onPointerDown={resize.beginResize('right')}
            />
            <Dialog.Title className="sr-only">{worker.name}</Dialog.Title>
            <Dialog.Description className="sr-only">
              {role.label} agent — status {status.label}
            </Dialog.Description>

            {startError ? (
              <div
                role="alert"
                className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs"
                style={{
                  background: 'color-mix(in oklab, var(--status-red) 10%, transparent)',
                  borderColor: 'color-mix(in oklab, var(--status-red) 30%, var(--border))',
                  color: 'var(--status-red)',
                }}
              >
                <AlertTriangle size={12} aria-hidden />
                <span className="break-words">{startError}</span>
              </div>
            ) : null}

            <div
              className="relative flex min-h-0 flex-1 flex-col p-3"
              data-testid="worker-modal-terminal-slot"
            >
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close worker detail"
                  title="Close"
                  className="float-action absolute top-4 right-4 z-10"
                >
                  <X size={14} aria-hidden />
                </button>
              </Dialog.Close>

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
                    <div className="text-sm text-pri">{worker.name}</div>
                    <div className="text-xs text-ter">
                      {worker.status === 'stopped' ? 'PTY stopped — ' : 'PTY not started yet — '}
                      {worker.pendingTaskCount > 0
                        ? `${worker.pendingTaskCount} pending task(s) will resume after restart.`
                        : 'Start the agent to begin receiving dispatches.'}
                    </div>
                    <button
                      type="button"
                      onClick={() => onStart(worker)}
                      disabled={starting}
                      className="icon-btn icon-btn--primary"
                      data-testid="worker-start-empty"
                    >
                      <Play size={12} aria-hidden /> {starting ? 'Starting…' : 'Start'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
