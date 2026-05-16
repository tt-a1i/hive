import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, ChevronRight, Folder, GitBranch } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { CommandPreset, FsProbeResponse } from '../api.js'
import { useI18n } from '../i18n.js'
import { WorkspaceCommandPresetSelect } from './WorkspaceCommandPresetSelect.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

type ConfirmWorkspaceDialogProps = {
  /** Probe result for the picked folder, or null when user chose the paste-path fallback. */
  probe: FsProbeResponse | null
  /** When true, the paste-path fallback section is expanded by default (unsupported platform). */
  pasteFallbackDefault?: boolean
  commandPresetError: string | null
  commandPresetId: string
  commandPresetTouched: boolean
  commandPresets: CommandPreset[]
  onCancel: () => void
  onCommandPresetChange: (value: string) => void
  onCreate: (input: WorkspaceCreateInput) => void
  onOpenServerBrowse: () => void
}

const basenameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? ''

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="text-xs font-medium uppercase tracking-wider text-ter">{children}</span>
)

export const ConfirmWorkspaceDialog = ({
  probe,
  pasteFallbackDefault = false,
  commandPresetError,
  commandPresetId,
  commandPresetTouched,
  commandPresets,
  onCancel,
  onCommandPresetChange,
  onCreate,
  onOpenServerBrowse,
}: ConfirmWorkspaceDialogProps) => {
  const { t } = useI18n()
  const initialPath = probe?.path ?? ''
  const initialName = probe?.suggested_name ?? basenameOf(initialPath)
  const [name, setName] = useState(initialName)
  const [pastePath, setPastePath] = useState('')
  const [pasteExpanded, setPasteExpanded] = useState(pasteFallbackDefault)
  const [startupExpanded, setStartupExpanded] = useState(false)
  const [startupCommand, setStartupCommand] = useState('')

  // Re-sync when the probe changes (user re-picks a folder without closing).
  useEffect(() => {
    setName(probe?.suggested_name ?? basenameOf(probe?.path ?? ''))
  }, [probe?.path, probe?.suggested_name])

  const pastedClean = pastePath.trim()
  const resolvedPath = pasteExpanded && pastedClean.length > 0 ? pastedClean : (probe?.path ?? '')
  const startupClean = startupCommand.trim()
  const selectedPreset = commandPresets.find((preset) => preset.id === commandPresetId)
  const presetsLoading = commandPresets.length === 0 && !commandPresetError
  const selectedPresetUnavailable = selectedPreset?.available === false && startupClean.length === 0
  const presetAvailabilityError = selectedPresetUnavailable
    ? t('workspace.preset.notInstalled', { name: selectedPreset.displayName })
    : null
  const canCreate =
    name.trim().length > 0 &&
    resolvedPath.length > 0 &&
    !presetsLoading &&
    !selectedPresetUnavailable

  const handleCreate = () => {
    if (!canCreate) return
    onCreate({
      commandPresetId: startupClean && !commandPresetTouched ? null : commandPresetId || null,
      name: name.trim(),
      path: resolvedPath,
      ...(startupClean ? { startupCommand: startupClean } : {}),
    })
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="confirm-workspace-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="confirm-workspace-dialog"
            className="dialog-scale-pop elev-2 pointer-events-auto flex w-[480px] max-w-full flex-col rounded-lg border"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <div
              className="flex items-center gap-3 border-b px-5 py-4"
              style={{ borderColor: 'var(--border)' }}
            >
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <Folder size={18} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('workspace.confirm.title')}
                </Dialog.Title>
                <Dialog.Description className="text-xs text-ter">
                  {t('workspace.confirm.description')}
                </Dialog.Description>
              </div>
            </div>

            <div className="flex flex-col gap-4 px-5 py-4">
              <label className="flex flex-col gap-2">
                <FieldLabel>{t('workspace.field.path')}</FieldLabel>
                <input
                  readOnly
                  value={probe?.path ?? ''}
                  placeholder={t('workspace.field.pathEmptyPlaceholder')}
                  className="input input--readonly mono"
                  data-testid="confirm-workspace-path"
                />
              </label>

              {probe?.is_git_repository ? (
                <div
                  className="flex items-center gap-2 text-xs"
                  data-testid="confirm-workspace-git-badge"
                >
                  <span
                    className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-medium"
                    style={{
                      background: 'color-mix(in oklab, var(--status-blue) 12%, transparent)',
                      color: 'var(--status-blue)',
                      border: '1px solid color-mix(in oklab, var(--status-blue) 30%, transparent)',
                    }}
                  >
                    <GitBranch size={12} aria-hidden />
                    {probe.current_branch ?? t('workspace.git.detached')}
                  </span>
                  <span className="text-ter">{t('workspace.git.detected')}</span>
                </div>
              ) : probe?.ok ? (
                <span className="text-xs text-ter">{t('workspace.git.none')}</span>
              ) : null}

              <label className="flex flex-col gap-2">
                <FieldLabel>{t('workspace.field.name')}</FieldLabel>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={
                    basenameOf(probe?.path ?? '') || t('workspace.field.nameDefaultPlaceholder')
                  }
                  className="input"
                  data-testid="confirm-workspace-name"
                />
              </label>

              <WorkspaceCommandPresetSelect
                error={commandPresetError ?? presetAvailabilityError}
                onChange={onCommandPresetChange}
                presets={commandPresets}
                value={commandPresetId}
              />

              <button
                type="button"
                onClick={() => setStartupExpanded((v) => !v)}
                className="flex items-center gap-1.5 self-start text-xs uppercase tracking-wider text-ter hover:text-sec"
                data-testid="confirm-workspace-startup-toggle"
              >
                {startupExpanded ? (
                  <ChevronDown size={12} aria-hidden />
                ) : (
                  <ChevronRight size={12} aria-hidden />
                )}
                {t('workspace.advanced.startup')}
              </button>
              {startupExpanded ? (
                <label className="flex flex-col gap-2">
                  <FieldLabel>{t('workspace.field.startup')}</FieldLabel>
                  <input
                    type="text"
                    value={startupCommand}
                    onChange={(event) => setStartupCommand(event.target.value)}
                    placeholder={t('workspace.field.startupPlaceholder')}
                    className="input mono"
                    data-testid="confirm-workspace-startup-command"
                  />
                  <span className="text-xs text-ter">{t('workspace.startup.hint')}</span>
                </label>
              ) : null}

              <button
                type="button"
                onClick={() => setPasteExpanded((v) => !v)}
                className="flex items-center gap-1.5 self-start text-xs uppercase tracking-wider text-ter hover:text-sec"
                data-testid="confirm-workspace-paste-toggle"
              >
                {pasteExpanded ? (
                  <ChevronDown size={12} aria-hidden />
                ) : (
                  <ChevronRight size={12} aria-hidden />
                )}
                {t('workspace.advanced.pastePath')}
              </button>
              {pasteExpanded ? (
                <label className="flex flex-col gap-2">
                  <FieldLabel>{t('workspace.field.absolutePath')}</FieldLabel>
                  <input
                    type="text"
                    value={pastePath}
                    onChange={(event) => setPastePath(event.target.value)}
                    placeholder={t('workspace.field.absolutePathPlaceholder')}
                    className="input mono"
                    data-testid="confirm-workspace-paste-path"
                  />
                </label>
              ) : null}

              <button
                type="button"
                onClick={onOpenServerBrowse}
                className="flex items-center gap-1.5 self-start text-xs uppercase tracking-wider text-ter hover:text-sec"
                data-testid="confirm-workspace-browse-toggle"
              >
                <ChevronRight size={12} aria-hidden />
                {t('workspace.advanced.browse')}
              </button>
            </div>

            <div
              className="flex items-center justify-end gap-2 border-t px-5 py-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <button type="button" onClick={onCancel} className="icon-btn">
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!canCreate}
                data-testid="confirm-workspace-create"
                className="icon-btn icon-btn--primary"
              >
                {t('workspace.confirm.create')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
