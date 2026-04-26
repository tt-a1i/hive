import { useEffect, useRef, useState } from 'react'

import { type FsProbeResponse, pickFolder } from '../api.js'
import { ConfirmWorkspaceDialog } from './ConfirmWorkspaceDialog.js'
import { ServerBrowseDialog } from './ServerBrowseDialog.js'

type AddWorkspaceDialogProps = {
  /**
   * Discriminator: `idle` = dialog closed; `request-pick` = parent asked us to
   * open a new flow, we should fire the native picker on mount.
   */
  trigger: number
  onClose: () => void
  onCreate: (input: { name: string; path: string }) => void
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'confirm'; probe: FsProbeResponse | null; pasteDefault: boolean }
  | { kind: 'browse' }
  | { kind: 'error'; message: string }

export const AddWorkspaceDialog = ({ trigger, onClose, onCreate }: AddWorkspaceDialogProps) => {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  // Keep the latest onClose in a ref so the pick effect can depend only on
  // `trigger`. If we listed onClose in the deps array, a fresh inline lambda
  // from the parent (which is the normal React pattern) would re-fire the
  // native picker every render — including after a successful create.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (trigger === 0) return
    let cancelled = false
    setStage({ kind: 'picking' })
    pickFolder()
      .then((result) => {
        if (cancelled) return
        // User canceled the native dialog — dismiss silently without showing
        // any additional UI. This mirrors how macOS Finder handles cancel.
        if (result.canceled) {
          setStage({ kind: 'idle' })
          onCloseRef.current()
          return
        }
        if (!result.supported) {
          // Platform has no native picker wired. Pop the compact confirm with
          // the paste-path fallback expanded by default.
          setStage({ kind: 'confirm', probe: null, pasteDefault: true })
          return
        }
        if (!result.probe?.ok || !result.probe.is_dir) {
          setStage({
            kind: 'error',
            message:
              result.error ?? 'Picked folder is not inside the Hive sandbox. Use paste path.',
          })
          return
        }
        setStage({ kind: 'confirm', probe: result.probe, pasteDefault: false })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Folder picker failed'
        setStage({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [trigger])

  const handleCancel = () => {
    setStage({ kind: 'idle' })
    onClose()
  }

  const handleCreate = (input: { name: string; path: string }) => {
    setStage({ kind: 'idle' })
    onCreate(input)
  }

  if (stage.kind === 'idle') return null
  if (stage.kind === 'picking') {
    return (
      <div
        className="fixed inset-0 z-40 flex items-center justify-center"
        data-testid="add-workspace-picking"
      >
        <div className="modal-backdrop absolute inset-0" />
        <div
          role="status"
          className="relative rounded-lg border px-4 py-3 text-xs text-ter shadow-xl"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
        >
          Opening system folder picker…
        </div>
      </div>
    )
  }
  if (stage.kind === 'error') {
    return (
      <div
        className="fixed inset-0 z-40 flex items-center justify-center"
        data-testid="add-workspace-error"
      >
        <button
          type="button"
          aria-label="Dismiss error"
          onClick={handleCancel}
          className="modal-backdrop absolute inset-0"
        />
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="Folder picker error"
          className="relative flex w-[420px] flex-col gap-3 rounded-lg border p-4 shadow-2xl"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
        >
          <p className="text-sm text-pri">Folder picker failed</p>
          <p className="text-xs text-ter">{stage.message}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleCancel}
              className="rounded px-3 py-1.5 text-xs text-sec hover:bg-3 hover:text-pri"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => setStage({ kind: 'confirm', probe: null, pasteDefault: true })}
              className="rounded px-3 py-1.5 text-xs text-white hover:opacity-90"
              style={{ background: 'var(--accent)' }}
            >
              Paste path instead
            </button>
          </div>
        </div>
      </div>
    )
  }
  if (stage.kind === 'browse') {
    return <ServerBrowseDialog open onClose={handleCancel} onCreate={handleCreate} />
  }
  return (
    <ConfirmWorkspaceDialog
      pasteFallbackDefault={stage.pasteDefault}
      probe={stage.probe}
      onCancel={handleCancel}
      onCreate={handleCreate}
      onOpenServerBrowse={() => setStage({ kind: 'browse' })}
    />
  )
}
