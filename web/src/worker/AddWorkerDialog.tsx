import * as Dialog from '@radix-ui/react-dialog'
import { BookmarkPlus, Dices, Store } from 'lucide-react'
import type { FormEvent } from 'react'
import { useState } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import type { CommandPreset, RoleTemplate } from '../api.js'
import { useI18n } from '../i18n.js'
import { MarketplaceDrawer } from '../marketplace/MarketplaceDrawer.js'
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
  customRoleName: string
  customTemplates: RoleTemplate[]
  onApplyMarketplaceImport: (input: { name: string; description: string }) => void
  onClose: () => void
  onCustomRoleNameChange: (value: string) => void
  onDeleteTemplate: (templateId: string) => Promise<void> | void
  onNameChange: (value: string) => void
  onNameFieldFocus?: () => void
  onPresetChange: (value: string) => void
  onRandomName: () => void
  onRoleDescriptionChange: (value: string) => void
  onRoleDescriptionReset: () => void
  onRoleChange: (value: WorkerRole) => void
  onSaveAsTemplate: (name: string) => Promise<void> | void
  onStartupCommandChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTemplateChange: (templateId: string | null) => void
  roleDescription: string
  roleDescriptionDefault: string
  selectedTemplateId: string | null
  startupCommand: string
  templateBusy: boolean
  usedTemplateNames?: Set<string> | undefined
  workerName: string
  workerRole: WorkerRole
  writeDisabledReason?: string | undefined
}

export const AddWorkerDialog = ({
  commandPresets,
  commandPresetId,
  creating = false,
  customRoleName,
  customTemplates,
  onApplyMarketplaceImport,
  onClose,
  onCustomRoleNameChange,
  onDeleteTemplate,
  onNameChange,
  onNameFieldFocus,
  onPresetChange,
  onRandomName,
  onRoleDescriptionChange,
  onRoleDescriptionReset,
  onRoleChange,
  onSaveAsTemplate,
  onStartupCommandChange,
  onSubmit,
  onTemplateChange,
  roleDescription,
  roleDescriptionDefault,
  selectedTemplateId,
  startupCommand,
  templateBusy,
  usedTemplateNames,
  workerName,
  workerRole,
  writeDisabledReason,
}: AddWorkerDialogProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const [marketplaceOpen, setMarketplaceOpen] = useState(false)
  const [saveAsTemplateMode, setSaveAsTemplateMode] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const importedNames = useMemo(
    () => new Set(customTemplates.map((template) => template.name)),
    [customTemplates]
  )
  const existingRoles = useMemo(
    () => customTemplates.filter((tpl) => !tpl.suggestedName && !tpl.commandPresetId),
    [customTemplates]
  )
  const handleMarketplaceImport = (detail: { name: string; description: string }) => {
    onApplyMarketplaceImport(detail)
    toast.show({ kind: 'success', message: t('marketplace.imported', { name: detail.name }) })
  }
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
    if (writeDisabledReason) return writeDisabledReason
    if (!workerName.trim()) return t('addWorker.enterName')
    if (workerRole === 'custom' && !selectedTemplateId && !customRoleName.trim()) {
      return t('addWorker.customRoleNameRequired')
    }
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
    if (saveAsTemplateMode && !templateName.trim()) {
      event.preventDefault()
      toast.show({ kind: 'warning', message: t('addWorker.templateNameRequired') })
      return
    }
    if (saveAsTemplateMode && templateName.trim()) {
      event.preventDefault()
      void onSaveAsTemplate(templateName.trim())
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
                    onFocus={onNameFieldFocus}
                    placeholder={t('addWorker.namePlaceholder')}
                    className="input"
                  />
                </label>

                <RolePicker
                  customTemplates={customTemplates}
                  workerRole={workerRole}
                  selectedTemplateName={customTemplates.find((t) => t.id === selectedTemplateId)?.name}
                  selectedTemplateId={selectedTemplateId}
                  usedTemplateNames={usedTemplateNames}
                  onRoleChange={onRoleChange}
                  onSelectTemplate={onTemplateChange}
                />
                <button
                  type="button"
                  onClick={() => setMarketplaceOpen(true)}
                  data-testid="open-marketplace"
                  className="marketplace-browse-btn flex cursor-pointer items-center gap-2 self-start rounded-md border px-3 py-1.5 text-xs text-sec outline-none transition-colors focus-visible:ring-2"
                  style={{
                    background: 'var(--bg-0)',
                    borderColor: 'var(--border-bright)',
                    ['--tw-ring-color' as string]:
                      'color-mix(in oklab, var(--accent) 45%, transparent)',
                  }}
                >
                  <Store size={14} aria-hidden />
                  {t('marketplace.openFromAddWorker')}
                </button>
                {workerRole === 'custom' && !selectedTemplateId ? (
                  <label className="flex flex-col gap-2">
                    <SectionLabel>{t('addWorker.customRoleName')}</SectionLabel>
                    <input
                      value={customRoleName}
                      onChange={(event) => onCustomRoleNameChange(event.target.value)}
                      placeholder={t('addWorker.customRoleNamePlaceholder')}
                      className="input"
                      data-testid="custom-role-name-input"
                    />
                  </label>
                ) : null}
                <RoleInstructionsField
                  canSaveAsTemplate={
                    workerRole === 'custom' &&
                    !selectedTemplateId &&
                    roleDescription.trim().length > 0
                  }
                  modified={roleDescriptionModified}
                  onChange={onRoleDescriptionChange}
                  onReset={onRoleDescriptionReset}
                  onSaveAsTemplate={onSaveAsTemplate}
                  roleDescription={roleDescription}
                  templateBusy={templateBusy}
                  workerRole={workerRole}
                  writeDisabledReason={writeDisabledReason}
                />
                <AgentCliPicker
                  commandPresetId={commandPresetId}
                  commandPresets={commandPresets}
                  onPresetChange={onPresetChange}
                />
                <StartupCommandField value={startupCommand} onChange={onStartupCommandChange} />
              </div>

              <div
                className="flex shrink-0 flex-col border-t"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
              >
                {saveAsTemplateMode ? (
                  <div
                    className="flex items-center gap-2 px-5 py-2"
                    style={{ background: 'var(--bg-elevated)' }}
                  >
                    <input
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      placeholder={`${workerName || 'Worker'} - ${commandPresets.find((p) => p.id === commandPresetId)?.displayName || 'agent'}`}
                      className="input flex-1 text-sm"
                      data-testid="save-template-name-input"
                    />
                    <button
                      type="button"
                      onClick={() => { setSaveAsTemplateMode(false); setTemplateName('') }}
                      className="text-xs text-sec hover:text-pri"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-2 px-5 py-3">
                  <button
                    type="button"
                    onClick={() => setSaveAsTemplateMode(!saveAsTemplateMode)}
                    className="flex items-center gap-1 text-xs text-sec hover:text-pri"
                    data-testid="save-as-template-toggle"
                  >
                    <BookmarkPlus size={12} aria-hidden />
                    {t('addWorker.saveAndAdd')}
                  </button>
                  <div className="flex items-center gap-2">
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
                      disabled={creating || Boolean(writeDisabledReason)}
                      title={writeDisabledReason ?? undefined}
                      className="icon-btn icon-btn--primary"
                      data-testid="add-worker-submit"
                    >
                      {creating ? t('addWorker.creating') : (saveAsTemplateMode ? t('addWorker.saveAndCreate') : t('addWorker.create'))}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
      <MarketplaceDrawer
        open={marketplaceOpen}
        onClose={() => setMarketplaceOpen(false)}
        onImport={handleMarketplaceImport}
        importedNames={importedNames}
      />
    </Dialog.Root>
  )
}
