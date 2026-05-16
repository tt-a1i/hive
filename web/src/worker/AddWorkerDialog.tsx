import * as Dialog from '@radix-ui/react-dialog'
import { Dices } from 'lucide-react'
import type { FormEvent } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import type { CommandPreset } from '../api.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useToast } from '../ui/useToast.js'
import {
  AgentCliPicker,
  RoleInstructionsField,
  RolePicker,
  SectionLabel,
  StartupCommandField,
} from './AddWorkerDialogFields.js'

type AddWorkerDialogProps = {
  commandPresets: CommandPreset[]
  commandPresetId: string
  creating?: boolean
  onClose: () => void
  onNameChange: (value: string) => void
  onPresetChange: (value: string) => void
  onRandomName: () => void
  onRoleDescriptionChange: (value: string) => void
  onRoleDescriptionReset: () => void
  onRoleChange: (value: WorkerRole) => void
  onStartupCommandChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  roleDescription: string
  roleDescriptionDefault: string
  startupCommand: string
  workerName: string
  workerRole: WorkerRole
}

export const AddWorkerDialog = ({
  commandPresets,
  commandPresetId,
  creating = false,
  onClose,
  onNameChange,
  onPresetChange,
  onRandomName,
  onRoleDescriptionChange,
  onRoleDescriptionReset,
  onRoleChange,
  onStartupCommandChange,
  onSubmit,
  roleDescription,
  roleDescriptionDefault,
  startupCommand,
  workerName,
  workerRole,
}: AddWorkerDialogProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const handleClose = (open: boolean) => {
    if (!open) onClose()
  }
  const roleDescriptionModified = roleDescription !== roleDescriptionDefault
  const selectedPreset = commandPresets.find((preset) => preset.id === commandPresetId)
  const startupCommandClean = startupCommand.trim()

  // Validation runs only on submit; we don't pre-disable the Add button so
  // the user always gets actionable feedback (a warning toast) instead of
  // a silently-greyed CTA. Returns the first blocking reason or null.
  const validateBeforeSubmit = (): string | null => {
    if (!workerName.trim()) return t('addWorker.enterName')
    if (!commandPresetId && !startupCommandClean) return t('addWorker.pickCliOrStartup')
    if (selectedPreset?.available === false && !startupCommandClean) {
      return t('addWorker.unavailable', { name: selectedPreset.displayName })
    }
    if (!roleDescription.trim()) return t('addWorker.emptyInstructions')
    return null
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    const reason = validateBeforeSubmit()
    if (reason) {
      event.preventDefault()
      toast.show({ kind: 'warning', message: reason })
      return
    }
    onSubmit(event)
  }

  return (
    <Dialog.Root open onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="add-worker-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="add-worker-content"
            className="dialog-scale-pop elev-2 pointer-events-auto flex max-h-[calc(100vh-32px)] w-[560px] max-w-full flex-col rounded-lg border"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <form
              onSubmit={handleSubmit}
              aria-label={t('addWorker.title')}
              className="flex flex-col"
            >
              <div
                className="flex shrink-0 flex-col gap-0.5 border-b px-5 py-4"
                style={{ borderColor: 'var(--border)' }}
              >
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('addWorker.title')}
                </Dialog.Title>
                <Dialog.Description className="text-sm text-ter">
                  {t('addWorker.description', { command: 'team send' })}
                </Dialog.Description>
              </div>

              <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
                <label className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <SectionLabel>{t('addWorker.name')}</SectionLabel>
                    <Tooltip label={t('addWorker.randomTooltip')}>
                      <button
                        type="button"
                        aria-label={t('addWorker.randomAria')}
                        className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ter transition-colors hover:bg-3 hover:text-sec"
                        onClick={onRandomName}
                        data-testid="random-worker-name"
                      >
                        <Dices size={12} aria-hidden />
                        {t('addWorker.random')}
                      </button>
                    </Tooltip>
                  </div>
                  <input
                    // biome-ignore lint/a11y/noAutofocus: dialog is opt-in; without this Radix parks focus on the first toolbar button (Random) rather than the name field
                    autoFocus
                    value={workerName}
                    onChange={(event) => onNameChange(event.target.value)}
                    placeholder={t('addWorker.namePlaceholder')}
                    className="input"
                  />
                </label>

                <RolePicker workerRole={workerRole} onRoleChange={onRoleChange} />
                <RoleInstructionsField
                  modified={roleDescriptionModified}
                  onChange={onRoleDescriptionChange}
                  onReset={onRoleDescriptionReset}
                  roleDescription={roleDescription}
                  workerRole={workerRole}
                />
                <AgentCliPicker
                  commandPresetId={commandPresetId}
                  commandPresets={commandPresets}
                  onPresetChange={onPresetChange}
                />
                <StartupCommandField value={startupCommand} onChange={onStartupCommandChange} />
              </div>

              <div
                className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
              >
                <button
                  type="button"
                  onClick={onClose}
                  className="icon-btn"
                  data-testid="add-worker-cancel"
                >
                  {t('addWorker.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="icon-btn icon-btn--primary"
                  data-testid="add-worker-submit"
                >
                  {creating ? t('addWorker.creating') : t('addWorker.create')}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
