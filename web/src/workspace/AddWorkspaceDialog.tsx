import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, FolderSearch } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { type CommandPreset, type FsProbeResponse, listCommandPresets, pickFolder } from '../api.js'
import { useI18n } from '../i18n.js'
import { ConfirmWorkspaceDialog } from './ConfirmWorkspaceDialog.js'
import { ServerBrowseDialog } from './ServerBrowseDialog.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

type AddWorkspaceDialogProps = {
  /**
   * Discriminator: `idle` = dialog closed; `request-pick` = parent asked us to
   * open a new flow. macOS/Linux fire the native picker; Windows opens the
   * server filesystem browser because the native picker can hide behind Chrome.
   */
  trigger: number
  onClose: () => void
  onCreate: (input: WorkspaceCreateInput) => Promise<unknown> | undefined
  /** Demo-mode escape hatch shown when no built-in CLI is installed (P0-B1). */
  onTryDemo?: () => void
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'confirm'; probe: FsProbeResponse | null; pasteDefault: boolean }
  | { kind: 'browse' }
  | { kind: 'error'; message: string; title?: string }

const DEFAULT_COMMAND_PRESET_ID = 'claude'

const chooseDefaultCommandPresetId = (presets: CommandPreset[]) =>
  presets.some((preset) => preset.id === DEFAULT_COMMAND_PRESET_ID && preset.available)
    ? DEFAULT_COMMAND_PRESET_ID
    : (presets.find((preset) => preset.available)?.id ??
      presets[0]?.id ??
      DEFAULT_COMMAND_PRESET_ID)

type NavigatorWithUserAgentData = Pick<Navigator, 'platform' | 'userAgent'> & {
  userAgentData?: { platform?: string }
}

export const prefersServerBrowseDefault = (
  nav: NavigatorWithUserAgentData | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator
): boolean => {
  if (!nav) return false
  const signals = [nav.userAgentData?.platform, nav.platform, nav.userAgent]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
  return /\bWindows?\b|\bWin(?:32|64|CE)\b|Windows NT/i.test(signals)
}

export const AddWorkspaceDialog = ({
  trigger,
  onClose,
  onCreate,
  onTryDemo,
}: AddWorkspaceDialogProps) => {
  const { t } = useI18n()
  // Effect-stable view of `t`: writing to a ref lets the trigger-driven
  // useEffect read the current translator without re-running each render
  // (which would re-fire the native folder picker every time language changes).
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const cancelPendingPickRef = useRef<(() => void) | null>(null)
  const [commandPresets, setCommandPresets] = useState<CommandPreset[]>([])
  const [commandPresetId, setCommandPresetId] = useState(DEFAULT_COMMAND_PRESET_ID)
  const [commandPresetError, setCommandPresetError] = useState<string | null>(null)
  const commandPresetSnapshotRef = useRef<{
    error: string | null
    id: string
    presets: CommandPreset[]
  }>({ error: null, id: DEFAULT_COMMAND_PRESET_ID, presets: [] })
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
    cancelPendingPickRef.current = () => {
      cancelled = true
    }
    setCommandPresetError(null)
    const presetsReady = listCommandPresets()
      .then((presets) => {
        if (cancelled) return
        const nextId = presets.some(
          (preset) => preset.id === commandPresetSnapshotRef.current.id && preset.available
        )
          ? commandPresetSnapshotRef.current.id
          : chooseDefaultCommandPresetId(presets)
        commandPresetSnapshotRef.current = { error: null, id: nextId, presets }
        setCommandPresets(presets)
        setCommandPresetId(nextId)
      })
      .catch(() => {
        if (cancelled) return
        const errorMessage = tRef.current('workspace.preset.loadFailed')
        commandPresetSnapshotRef.current = {
          error: errorMessage,
          id: DEFAULT_COMMAND_PRESET_ID,
          presets: [],
        }
        setCommandPresets([])
        setCommandPresetId(DEFAULT_COMMAND_PRESET_ID)
        setCommandPresetError(errorMessage)
      })
    if (prefersServerBrowseDefault()) {
      setStage({ kind: 'browse' })
      return () => {
        cancelled = true
      }
    }
    setStage({ kind: 'picking' })
    pickFolder()
      .then(async (result) => {
        await presetsReady
        if (cancelled) return
        // User canceled the native dialog — dismiss silently without showing
        // any additional UI. This mirrors how macOS Finder handles cancel.
        if (result.canceled) {
          if (result.error) {
            setStage({ kind: 'error', message: result.error })
            return
          }
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
            message: result.error ?? tRef.current('workspace.error.outsideSandbox'),
          })
          return
        }
        setStage({ kind: 'confirm', probe: result.probe, pasteDefault: false })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message =
          error instanceof Error ? error.message : tRef.current('workspace.error.pickerFailed')
        setStage({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [trigger])

  const handleCancel = () => {
    cancelPendingPickRef.current?.()
    setStage({ kind: 'idle' })
    onClose()
  }

  // Close the dialog before flipping into demo mode so the overlay does not
  // linger on top of the demo workspace view.
  const handleTryDemo = onTryDemo
    ? () => {
        handleCancel()
        onTryDemo()
      }
    : undefined

  const handleCreate = (input: WorkspaceCreateInput) => {
    void Promise.resolve(onCreate(input))
      .then(() => setStage({ kind: 'idle' }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : t('workspace.error.createFailed')
        setStage({ kind: 'error', title: t('workspace.error.createTitle'), message })
      })
  }

  const handleCommandPresetChange = (value: string) => {
    commandPresetSnapshotRef.current = { ...commandPresetSnapshotRef.current, id: value }
    setCommandPresetId(value)
  }

  const renderedCommandPresets =
    commandPresets.length > 0 || commandPresetError
      ? commandPresets
      : commandPresetSnapshotRef.current.presets
  const renderedCommandPresetId =
    commandPresetId === ''
      ? ''
      : renderedCommandPresets.length > 0 &&
          !renderedCommandPresets.some(
            (preset) => preset.id === commandPresetId && preset.available
          )
        ? commandPresetSnapshotRef.current.id
        : commandPresetId
  const renderedCommandPresetError = commandPresetError ?? commandPresetSnapshotRef.current.error

  if (stage.kind === 'idle') return null
  if (stage.kind === 'picking') {
    // Dismiss pending results too: the native picker may have returned while
    // presets are still loading, and this component stays mounted after close.
    return (
      <Dialog.Root open onOpenChange={(next) => !next && handleCancel()}>
        <Dialog.Portal>
          <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
          <Dialog.Content
            data-testid="add-workspace-picking"
            aria-describedby={undefined}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            <Dialog.Title className="sr-only">{t('workspace.picking.title')}</Dialog.Title>
            <div
              data-testid="add-workspace-picking-panel"
              className="dialog-scale-pop elev-2 flex items-center gap-3 rounded-lg border px-5 py-4"
              style={{
                background: 'var(--bg-elevated)',
                borderColor: 'var(--border-bright)',
              }}
            >
              <FolderSearch
                size={18}
                aria-hidden
                className="animate-pulse"
                style={{ color: 'var(--accent)' }}
              />
              <span className="text-sm text-pri">{t('workspace.picking.message')}</span>
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
          <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
            <Dialog.Content
              data-testid="add-workspace-error"
              className="dialog-scale-pop elev-2 pointer-events-auto w-[440px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
              style={{
                background: 'var(--bg-elevated)',
                borderColor: 'var(--border-bright)',
              }}
            >
              <div className="flex items-start gap-3">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                  style={{
                    background: 'color-mix(in oklab, var(--status-red) 14%, transparent)',
                    color: 'var(--status-red)',
                  }}
                >
                  <AlertTriangle size={18} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-lg font-semibold text-pri">
                    {stage.title ?? t('workspace.error.pickerFailed')}
                  </Dialog.Title>
                  <Dialog.Description className="mt-1.5 break-words text-sm text-ter">
                    {stage.message}
                  </Dialog.Description>
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" onClick={handleCancel} className="icon-btn">
                  {t('common.close')}
                </button>
                <button
                  type="button"
                  onClick={() => setStage({ kind: 'confirm', probe: null, pasteDefault: true })}
                  className="icon-btn icon-btn--primary"
                >
                  {t('workspace.error.pastePathInstead')}
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
  if (stage.kind === 'browse') {
    return (
      <ServerBrowseDialog
        commandPresetError={renderedCommandPresetError}
        commandPresetId={renderedCommandPresetId}
        commandPresets={renderedCommandPresets}
        onClose={handleCancel}
        onCommandPresetChange={handleCommandPresetChange}
        onCreate={handleCreate}
        open
      />
    )
  }
  return (
    <ConfirmWorkspaceDialog
      commandPresetError={renderedCommandPresetError}
      commandPresetId={renderedCommandPresetId}
      commandPresets={renderedCommandPresets}
      pasteFallbackDefault={stage.pasteDefault}
      probe={stage.probe}
      onCancel={handleCancel}
      onCommandPresetChange={handleCommandPresetChange}
      onCreate={handleCreate}
      onOpenServerBrowse={() => setStage({ kind: 'browse' })}
      {...(handleTryDemo ? { onTryDemo: handleTryDemo } : {})}
    />
  )
}
