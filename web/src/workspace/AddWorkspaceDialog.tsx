import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, FolderSearch } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { type CommandPreset, type FsProbeResponse, listCommandPresets, pickFolder } from '../api.js'
import { ConfirmWorkspaceDialog } from './ConfirmWorkspaceDialog.js'
import { ServerBrowseDialog } from './ServerBrowseDialog.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

type AddWorkspaceDialogProps = {
  /**
   * Discriminator: `idle` = dialog closed; `request-pick` = parent asked us to
   * open a new flow, we should fire the native picker on mount.
   */
  trigger: number
  onClose: () => void
  onCreate: (input: WorkspaceCreateInput) => void
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'confirm'; probe: FsProbeResponse | null; pasteDefault: boolean }
  | { kind: 'browse' }
  | { kind: 'error'; message: string }

const DEFAULT_COMMAND_PRESET_ID = 'claude'

const chooseDefaultCommandPresetId = (presets: CommandPreset[]) =>
  presets.some((preset) => preset.id === DEFAULT_COMMAND_PRESET_ID)
    ? DEFAULT_COMMAND_PRESET_ID
    : (presets[0]?.id ?? DEFAULT_COMMAND_PRESET_ID)

export const AddWorkspaceDialog = ({ trigger, onClose, onCreate }: AddWorkspaceDialogProps) => {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [commandPresets, setCommandPresets] = useState<CommandPreset[]>([])
  const [commandPresetId, setCommandPresetId] = useState(DEFAULT_COMMAND_PRESET_ID)
  const [commandPresetError, setCommandPresetError] = useState<string | null>(null)
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
    setCommandPresetError(null)
    void listCommandPresets()
      .then((presets) => {
        if (cancelled) return
        setCommandPresets(presets)
        setCommandPresetId((current) =>
          presets.some((preset) => preset.id === current)
            ? current
            : chooseDefaultCommandPresetId(presets)
        )
      })
      .catch(() => {
        if (cancelled) return
        setCommandPresets([])
        setCommandPresetId(DEFAULT_COMMAND_PRESET_ID)
        setCommandPresetError('Failed to load CLI presets; using server default.')
      })
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

  const handleCreate = (input: WorkspaceCreateInput) => {
    setStage({ kind: 'idle' })
    onCreate(input)
  }

  if (stage.kind === 'idle') return null
  if (stage.kind === 'picking') {
    return (
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
          <Dialog.Content
            data-testid="add-workspace-picking"
            aria-describedby={undefined}
            className="elev-2 fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg border px-5 py-4"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <Dialog.Title className="sr-only">Opening folder picker</Dialog.Title>
            <div className="flex items-center gap-3">
              <FolderSearch
                size={18}
                aria-hidden
                className="animate-pulse"
                style={{ color: 'var(--accent)' }}
              />
              <span className="text-sm text-pri">Opening system folder picker…</span>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
  if (stage.kind === 'error') {
    return (
      <Dialog.Root open onOpenChange={(open) => !open && handleCancel()}>
        <Dialog.Portal>
          <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
          <Dialog.Content
            data-testid="add-workspace-error"
            className="elev-2 fixed top-1/2 left-1/2 z-50 w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-5"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <div className="flex items-start gap-3">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                style={{
                  background: 'color-mix(in oklab, var(--status-red) 14%, transparent)',
                  color: 'var(--status-red)',
                }}
              >
                <AlertTriangle size={18} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-md font-medium text-pri">
                  Folder picker failed
                </Dialog.Title>
                <Dialog.Description className="mt-1.5 break-words text-[12px] leading-snug text-ter">
                  {stage.message}
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={handleCancel} className="icon-btn">
                Close
              </button>
              <button
                type="button"
                onClick={() => setStage({ kind: 'confirm', probe: null, pasteDefault: true })}
                className="icon-btn icon-btn--primary"
              >
                Paste path instead
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
  if (stage.kind === 'browse') {
    return (
      <ServerBrowseDialog
        commandPresetError={commandPresetError}
        commandPresetId={commandPresetId}
        commandPresets={commandPresets}
        onClose={handleCancel}
        onCommandPresetChange={setCommandPresetId}
        onCreate={handleCreate}
        open
      />
    )
  }
  return (
    <ConfirmWorkspaceDialog
      commandPresetError={commandPresetError}
      commandPresetId={commandPresetId}
      commandPresets={commandPresets}
      pasteFallbackDefault={stage.pasteDefault}
      probe={stage.probe}
      onCancel={handleCancel}
      onCommandPresetChange={setCommandPresetId}
      onCreate={handleCreate}
      onOpenServerBrowse={() => setStage({ kind: 'browse' })}
    />
  )
}
