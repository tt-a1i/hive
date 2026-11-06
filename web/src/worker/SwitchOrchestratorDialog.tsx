import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'

import type { CommandPreset } from '../api.js'
import { useI18n } from '../i18n.js'
import { CliInstallGuidancePanel } from '../workspace/CliInstallGuidance.js'
import { useCommandPresets } from '../workspace/useCommandPresets.js'

export const SwitchOrchestratorDialog = ({
  onClose,
  onSwitch,
}: {
  onClose: () => void
  onSwitch: (preset: CommandPreset) => Promise<void>
}) => {
  const { t } = useI18n()
  const { commandPresets, commandPresetId, commandPresetError, onCommandPresetChange } =
    useCommandPresets(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = commandPresets.find((preset) => preset.id === commandPresetId)

  const submit = async () => {
    if (busy || !selected?.available) return
    setBusy(true)
    setError(null)
    try {
      await onSwitch(selected)
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-[60]" />
        <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center p-4">
          <Dialog.Content
            className="dialog-scale-pop elev-2 pointer-events-auto flex w-[440px] max-w-[calc(100vw-32px)] flex-col gap-4 rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
            onEscapeKeyDown={(event) => busy && event.preventDefault()}
            onPointerDownOutside={(event) => busy && event.preventDefault()}
          >
            <Dialog.Title className="text-lg font-semibold text-pri">
              {t('orchestrator.switchCli')}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-sec">
              {t('orchestrator.switchCliDesc')}
            </Dialog.Description>
            <label className="flex flex-col gap-2 text-sm text-sec">
              {t('workspace.preset.label')}
              <select
                className="cli-select__field"
                value={commandPresetId}
                disabled={busy || commandPresets.length === 0}
                onChange={(event) => onCommandPresetChange(event.target.value)}
              >
                {commandPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.displayName}
                  </option>
                ))}
              </select>
            </label>
            {selected?.available === false ? (
              <CliInstallGuidancePanel presetId={selected.id} presetName={selected.displayName} />
            ) : null}
            {error || commandPresetError ? (
              <p role="alert" className="text-sm text-[var(--status-red)]">
                {error ?? commandPresetError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button type="button" className="icon-btn" disabled={busy} onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--primary"
                disabled={busy || !selected?.available}
                onClick={() => void submit()}
              >
                {busy ? t('orchestrator.startingTitle') : t('orchestrator.switchCliConfirm')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
