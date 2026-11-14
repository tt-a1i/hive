import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, ChevronRight, Folder, GitBranch, Play, Sliders } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { CommandPreset, FsProbeResponse } from '../api.js'
import { useI18n } from '../i18n.js'
import { CliInstallGuidancePanel } from './CliInstallGuidance.js'
import { sanitizePastedPath } from './path-input.js'
import { WorkspaceCommandPresetSelect } from './WorkspaceCommandPresetSelect.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

type ConfirmWorkspaceDialogProps = {
  /** Probe result for the picked folder, or null when user chose the paste-path fallback. */
  probe: FsProbeResponse | null
  /** When true, the paste-path fallback section is expanded by default (unsupported platform). */
  pasteFallbackDefault?: boolean
  commandPresetError: string | null
  commandPresetId: string
  commandPresets: CommandPreset[]
  onCancel: () => void
  onCommandPresetChange: (value: string) => void
  onCreate: (input: WorkspaceCreateInput) => void
  onOpenServerBrowse: () => void
  /** Jumps into demo mode; surfaced as a fallback when no built-in CLI is installed. */
  onTryDemo?: () => void
}

const basenameOf = (path: string): string =>
  (path.split(/[\\/]/).filter(Boolean).pop() ?? '').replace(/:$/u, '')

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="text-xs font-medium uppercase tracking-wider text-ter">{children}</span>
)

export const ConfirmWorkspaceDialog = ({
  probe,
  pasteFallbackDefault = false,
  commandPresetError,
  commandPresetId,
  commandPresets,
  onCancel,
  onCommandPresetChange,
  onCreate,
  onOpenServerBrowse,
  onTryDemo,
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

  const pastedClean = sanitizePastedPath(pastePath)
  const pastedSuggestedName = basenameOf(pastedClean)
  const resolvedPath = pasteExpanded && pastedClean.length > 0 ? pastedClean : (probe?.path ?? '')
  const startupClean = startupCommand.trim()
  const selectedPreset = commandPresets.find((preset) => preset.id === commandPresetId)
  const presetsLoading = commandPresets.length === 0 && !commandPresetError
  const genericPresetNeedsStartup = !commandPresetId && startupClean.length === 0
  const selectedPresetUnavailable = selectedPreset?.available === false && startupClean.length === 0
  const presetAvailabilityError = genericPresetNeedsStartup
    ? t('workspace.preset.genericRequiresStartup')
    : selectedPresetUnavailable
      ? t('workspace.preset.notInstalled', { name: selectedPreset.displayName })
      : null
  const allPresetsUnavailable =
    commandPresets.length > 0 && commandPresets.every((preset) => preset.available === false)
  const canCreate =
    name.trim().length > 0 &&
    resolvedPath.length > 0 &&
    !presetsLoading &&
    !genericPresetNeedsStartup &&
    !selectedPresetUnavailable

  const handleCreate = () => {
    if (!canCreate) return
    onCreate({
      commandPresetId: commandPresetId || null,
      name: name.trim(),
      path: resolvedPath,
      ...(startupClean ? { startupCommand: startupClean } : {}),
    })
  }

  useEffect(() => {
    if (pasteExpanded && pastedClean.length > 0) setName(pastedSuggestedName)
  }, [pasteExpanded, pastedClean, pastedSuggestedName])

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="confirm-workspace-overlay"
          className="app-overlay fixed inset-0 z-[70]"
        />
        <div className="pointer-events-none fixed inset-0 z-[80] grid place-items-center p-4">
          <Dialog.Content
            data-testid="confirm-workspace-dialog"
            className="dialog-scale-pop elev-2 pointer-events-auto flex max-h-[calc(100dvh-2rem)] w-[480px] max-w-full flex-col overflow-y-auto rounded-lg border"
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
              <div className="flex flex-col gap-1.5">
                <FieldLabel>{t('workspace.field.path')}</FieldLabel>
                {/* Hidden input for test compatibility with getByTestId('confirm-workspace-path').toHaveValue() */}
                <input
                  type="hidden"
                  value={probe?.path ?? ''}
                  data-testid="confirm-workspace-path"
                  readOnly
                />
                <div
                  className="flex items-center justify-between gap-3 rounded-lg border p-3 transition-all"
                  style={{
                    background: 'var(--bg-2)',
                    borderColor: 'var(--border)',
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <span
                      className="block truncate font-mono text-sm text-pri"
                      title={probe?.path ?? ''}
                    >
                      {probe?.path || t('workspace.field.pathEmptyPlaceholder')}
                    </span>
                  </div>
                  {probe?.is_git_repository ? (
                    <div
                      className="shrink-0 flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium"
                      style={{
                        background: 'color-mix(in oklab, var(--status-blue) 12%, transparent)',
                        color: 'var(--status-blue)',
                        border:
                          '1px solid color-mix(in oklab, var(--status-blue) 25%, transparent)',
                      }}
                      data-testid="confirm-workspace-git-badge"
                    >
                      <GitBranch size={12} aria-hidden />
                      <span className="truncate max-w-[90px]">
                        {probe.current_branch ?? t('workspace.git.detached')}
                      </span>
                    </div>
                  ) : null}
                </div>
                {probe?.ok && !probe?.is_git_repository && (
                  <span className="text-xs text-ter pl-1">{t('workspace.git.none')}</span>
                )}
              </div>

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

              {selectedPresetUnavailable && selectedPreset ? (
                <CliInstallGuidancePanel
                  presetId={selectedPreset.id}
                  presetName={selectedPreset.displayName}
                />
              ) : null}

              <p
                className="rounded-lg border p-3 text-xs text-sec"
                style={{
                  background: 'color-mix(in oklab, var(--status-yellow) 5%, transparent)',
                  borderColor: 'color-mix(in oklab, var(--status-yellow) 25%, transparent)',
                }}
                data-testid="yolo-mode-notice"
              >
                {t('workspace.yolo.notice')}
              </p>

              {allPresetsUnavailable && onTryDemo ? (
                <div
                  className="flex flex-col gap-2 rounded-lg border p-3"
                  style={{
                    background: 'color-mix(in oklab, var(--accent) 6%, transparent)',
                    borderColor: 'color-mix(in oklab, var(--accent) 30%, transparent)',
                  }}
                  data-testid="cli-none-available"
                >
                  <span className="text-xs text-sec">{t('workspace.preset.noneAvailable')}</span>
                  <button
                    type="button"
                    onClick={onTryDemo}
                    className="icon-btn w-full justify-center inline-flex items-center gap-2"
                    data-testid="cli-try-demo"
                  >
                    <Play size={13} aria-hidden />
                    {t('workspace.preset.tryDemo')}
                  </button>
                </div>
              ) : null}

              {/* Advanced Configurations */}
              <div
                className="mt-2 rounded-lg border overflow-hidden transition-all"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--bg-1)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setStartupExpanded((v) => !v)}
                  className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-sec hover:bg-3 transition-colors cursor-pointer"
                  data-testid="confirm-workspace-startup-toggle"
                >
                  <span className="flex items-center gap-2">
                    <Sliders size={12} aria-hidden className="text-ter" />
                    {t('workspace.advanced.startup')}
                  </span>
                  {startupExpanded ? (
                    <ChevronDown size={14} aria-hidden />
                  ) : (
                    <ChevronRight size={14} aria-hidden />
                  )}
                </button>
                {startupExpanded ? (
                  <div
                    className="flex flex-col gap-2 border-t p-3.5 transition-all"
                    style={{
                      background: 'var(--bg-2)',
                      borderColor: 'var(--border)',
                    }}
                  >
                    <FieldLabel>{t('workspace.field.startup')}</FieldLabel>
                    <input
                      type="text"
                      value={startupCommand}
                      onChange={(event) => setStartupCommand(event.target.value)}
                      placeholder={t('workspace.field.startupPlaceholder')}
                      className="input mono text-sm"
                      data-testid="confirm-workspace-startup-command"
                    />
                    <span className="text-[11px] text-ter normal-case tracking-normal leading-relaxed">
                      {t('workspace.startup.hint')}
                    </span>
                  </div>
                ) : null}
              </div>

              <div
                className="rounded-lg border overflow-hidden transition-all"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--bg-1)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setPasteExpanded((v) => !v)}
                  className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-sec hover:bg-3 transition-colors cursor-pointer"
                  data-testid="confirm-workspace-paste-toggle"
                >
                  <span className="flex items-center gap-2">
                    <Sliders size={12} aria-hidden className="text-ter" />
                    {t('workspace.advanced.pastePath')}
                  </span>
                  {pasteExpanded ? (
                    <ChevronDown size={14} aria-hidden />
                  ) : (
                    <ChevronRight size={14} aria-hidden />
                  )}
                </button>
                {pasteExpanded ? (
                  <div
                    className="flex flex-col gap-2 border-t p-3.5 transition-all"
                    style={{
                      background: 'var(--bg-2)',
                      borderColor: 'var(--border)',
                    }}
                  >
                    <FieldLabel>{t('workspace.field.absolutePath')}</FieldLabel>
                    <input
                      type="text"
                      value={pastePath}
                      onChange={(event) => setPastePath(event.target.value)}
                      placeholder={t('workspace.field.absolutePathPlaceholder')}
                      className="input mono text-sm"
                      data-testid="confirm-workspace-paste-path"
                    />
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                onClick={onOpenServerBrowse}
                className="flex items-center justify-between w-full rounded-lg border border-dashed px-3.5 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-sec hover:bg-3 hover:text-pri transition-all cursor-pointer"
                style={{ borderColor: 'var(--border)' }}
                data-testid="confirm-workspace-browse-toggle"
              >
                <span className="flex items-center gap-2">
                  <Folder size={12} aria-hidden className="text-ter" />
                  {t('workspace.advanced.browse')}
                </span>
                <ChevronRight size={14} aria-hidden />
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
