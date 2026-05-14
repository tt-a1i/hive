import * as Dialog from '@radix-ui/react-dialog'
import { Pencil } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'

type RenameWorkerDialogProps = {
  worker: TeamListItem | null
  busy?: boolean
  onClose: () => void
  onSubmit: (worker: TeamListItem, name: string) => void
}

export const RenameWorkerDialog = ({
  worker,
  busy = false,
  onClose,
  onSubmit,
}: RenameWorkerDialogProps) => {
  const [draft, setDraft] = useState(worker?.name ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (worker) {
      setDraft(worker.name)
      const id = window.setTimeout(() => {
        inputRef.current?.select()
      }, 30)
      return () => window.clearTimeout(id)
    }
  }, [worker])

  if (!worker) return null

  const trimmed = draft.trim()
  const canSave = trimmed.length > 0 && trimmed !== worker.name && !busy

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    onSubmit(worker, trimmed)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="rename-worker-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="rename-worker-dialog"
            className="dialog-scale-pop elev-2 pointer-events-auto w-[420px] max-w-full rounded-lg border p-5"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <div
                  aria-hidden
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                    color: 'var(--accent)',
                    border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
                  }}
                >
                  <Pencil size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="display text-[15px] font-medium text-pri">
                    Rename team member
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-ter">
                    Pick a new display name. The agent's id and PTY are unchanged.
                  </Dialog.Description>
                </div>
              </div>
              <label className="flex flex-col gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-ter">
                  Name
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={64}
                  className="input"
                  data-testid="rename-worker-input"
                />
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="icon-btn"
                  data-testid="rename-worker-cancel"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSave}
                  className="icon-btn icon-btn--primary"
                  data-testid="rename-worker-save"
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
