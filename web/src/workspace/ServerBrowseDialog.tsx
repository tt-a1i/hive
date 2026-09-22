import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUp, ChevronDown, ChevronRight, Folder, HardDrive, Sliders, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { WINDOWS_DRIVES_ROOT } from '../../../src/shared/fs-browse.js'
import type { CommandPreset } from '../api.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { ControllerModeSelect } from './ControllerModeSelect.js'
import { FsEntryList } from './FsEntryList.js'
import { FsSelectionPreview } from './FsSelectionPreview.js'
import { buildBreadcrumbs } from './path-breadcrumbs.js'
import { sanitizePastedPath } from './path-input.js'
import { detectPathSeparator } from './path-join.js'
import { useFsBrowser } from './useFsBrowser.js'
import { WorkspaceCommandPresetSelect } from './WorkspaceCommandPresetSelect.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

type ServerBrowseDialogProps = {
  commandPresetError: string | null
  commandPresetId: string
  commandPresets: CommandPreset[]
  onClose: () => void
  onCommandPresetChange: (value: string) => void
  onCreate: (input: WorkspaceCreateInput) => void
  open: boolean
  /**
   * Start with the paste-path field expanded. Defaults to `false` (desktop:
   * the manual-path input lives behind the "Advanced" toggle). The mobile
   * add-workspace surface passes `true` so a phone user — who has no OS picker —
   * sees the path field as the headline affordance.
   */
  initialAdvanced?: boolean
  /** Optional hint shown above the manual-path field (mobile copy). */
  manualHint?: string
}

const basenameOfPath = (path: string): string =>
  (path.split(/[\\/]/).filter(Boolean).pop() ?? '').replace(/:$/u, '')

/**
 * Server-side filesystem browser dialog — the kanban-style "remote" picker.
 * Served via the `▸ Advanced: browse server filesystem` affordance on the
 * compact confirm dialog, and used as the default on Windows where the native
 * PowerShell picker can be hidden behind the browser. macOS/Linux still prefer
 * the native OS folder picker (`pickFolder()`); this surface also exists for
 * SSH / headless runtime scenarios where no OS dialog is available.
 */
export const ServerBrowseDialog = ({
  commandPresetError,
  commandPresetId,
  commandPresets,
  onClose,
  onCommandPresetChange,
  onCreate,
  open,
  initialAdvanced = false,
  manualHint,
}: ServerBrowseDialogProps) => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const { browse, loading, navigate, probe, selectEntry, selected } = useFsBrowser(open)
  const [name, setName] = useState('')
  const [advanced, setAdvanced] = useState(initialAdvanced)
  const [manualPath, setManualPath] = useState('')
  const [startupExpanded, setStartupExpanded] = useState(false)
  const [startupCommand, setStartupCommand] = useState('')
  const [controllerMode, setControllerMode] = useState<'internal' | 'codex_app'>('internal')
  const externalController = controllerMode === 'codex_app'
  const sanitizedManualPath = sanitizePastedPath(manualPath)
  const manualSuggestedName = basenameOfPath(sanitizedManualPath)
  const suggestedName =
    advanced && sanitizedManualPath.length > 0 ? manualSuggestedName : probe?.suggested_name

  useEffect(() => {
    if (!open) {
      setName('')
      setAdvanced(initialAdvanced)
      setManualPath('')
      setStartupExpanded(false)
      setStartupCommand('')
    }
  }, [open, initialAdvanced])

  useEffect(() => {
    if (suggestedName) setName(suggestedName)
  }, [suggestedName])

  if (!open) return null

  const virtualRootLabel = t('workspace.browse.drivesRoot')
  const browseRootLabel =
    browse.root_path === WINDOWS_DRIVES_ROOT ? virtualRootLabel : browse.root_path
  const breadcrumbs = buildBreadcrumbs(browse.current_path, browse.root_path, virtualRootLabel)
  const showDrivesShortcut =
    browse.root_path === WINDOWS_DRIVES_ROOT && browse.current_path !== WINDOWS_DRIVES_ROOT
  const breadcrumbSeparator = detectPathSeparator(browse.current_path || browse.root_path)
  const selectedPreset = commandPresets.find((preset) => preset.id === commandPresetId)
  const startupClean = startupCommand.trim()
  const presetsLoading = commandPresets.length === 0 && !commandPresetError
  const genericPresetNeedsStartup = !commandPresetId && startupClean.length === 0
  const selectedPresetUnavailable = selectedPreset?.available === false && startupClean.length === 0
  const presetAvailabilityError = genericPresetNeedsStartup
    ? t('workspace.preset.genericRequiresStartup')
    : selectedPresetUnavailable
      ? t('workspace.preset.notInstalled', { name: selectedPreset.displayName })
      : null
  const canCreate =
    name.trim().length > 0 &&
    (probe?.is_dir === true || (advanced && sanitizedManualPath.length > 0)) &&
    (externalController ||
      (!presetsLoading && !genericPresetNeedsStartup && !selectedPresetUnavailable))

  const handleCreate = () => {
    const path =
      advanced && sanitizedManualPath.length > 0 ? sanitizedManualPath : (probe?.path ?? '')
    if (!path) return
    onCreate({
      ...(externalController ? { controllerMode: 'codex_app' as const } : {}),
      commandPresetId: externalController ? null : commandPresetId || null,
      name: name.trim(),
      path,
      ...(!externalController && startupClean ? { startupCommand: startupClean } : {}),
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="server-browse-overlay"
          className="app-overlay fixed inset-0 z-[70]"
        />
        {/* Grid place-items-center is more robust than transform-based */}
        {/* centering when the document has containment contexts (e.g. the */}
        {/* sidebar's container-type) that can shift the fixed positioning */}
        {/* containing-block. Mirrors ConfirmWorkspaceDialog. */}
        <div className="pointer-events-none fixed inset-0 z-[80] grid place-items-center max-md:items-end max-md:p-0 p-4">
          <Dialog.Content
            data-testid="add-workspace-dialog"
            data-mobile={isMobile || undefined}
            className={`${isMobile ? 'dialog-slide-up' : 'dialog-scale-pop'} elev-2 pointer-events-auto flex overflow-hidden w-[760px] max-w-[calc(100vw-32px)] flex-col rounded-lg border max-md:w-full max-md:max-w-full max-md:rounded-b-none max-md:rounded-t-xl`}
            style={{
              height: isMobile ? '85dvh' : 'min(600px, calc(100vh - 64px))',
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <div
              className="flex shrink-0 items-center gap-3 border-b px-5 py-4"
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
                  {t('workspace.browse.title')}
                </Dialog.Title>
                <Dialog.Description
                  className="mono truncate text-xs text-ter"
                  data-testid="fs-root-path"
                >
                  {browse.root_path
                    ? t('workspace.browse.root', { path: browseRootLabel })
                    : t('workspace.browse.rootLoading')}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={t('common.closeDialog')}
                  className="flex h-7 w-7 items-center justify-center rounded text-sec hover:bg-3 hover:text-pri"
                >
                  <X size={14} aria-hidden />
                </button>
              </Dialog.Close>
            </div>

            <nav
              className="flex shrink-0 items-center gap-1 border-b px-4 py-2 text-xs"
              style={{ borderColor: 'var(--border)' }}
              aria-label={t('workspace.browse.breadcrumb')}
              data-testid="fs-breadcrumb"
            >
              <button
                type="button"
                onClick={() => (browse.parent_path ? navigate(browse.parent_path) : null)}
                disabled={!browse.parent_path}
                aria-label={t('workspace.browse.parentAria')}
                className="flex items-center gap-1 rounded px-2 py-0.5 text-sec hover:bg-3 hover:text-pri disabled:opacity-40"
              >
                <ArrowUp size={12} aria-hidden /> {t('workspace.browse.up')}
              </button>
              {showDrivesShortcut ? (
                <button
                  type="button"
                  onClick={() => navigate(WINDOWS_DRIVES_ROOT)}
                  aria-label={t('workspace.browse.drivesAria')}
                  data-testid="fs-browse-drives"
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-sec hover:bg-3 hover:text-pri"
                >
                  <HardDrive size={12} aria-hidden /> {virtualRootLabel}
                </button>
              ) : null}
              <div className="mx-2 h-4 w-px" style={{ background: 'var(--border)' }} />
              {breadcrumbs.map((segment, index) => {
                const isLast = index === breadcrumbs.length - 1
                return (
                  <span key={segment.path} className="flex items-center gap-0.5">
                    {index > 0 ? <span className="text-ter">{breadcrumbSeparator}</span> : null}
                    {isLast ? (
                      <span className="px-1 py-0.5 font-medium text-pri">{segment.label}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => navigate(segment.path)}
                        className="rounded px-1 py-0.5 text-sec hover:bg-3 hover:text-pri"
                      >
                        {segment.label}
                      </button>
                    )}
                  </span>
                )
              })}
            </nav>

            <div className="flex min-h-0 flex-1 overflow-y-auto md:overflow-hidden max-md:flex-col">
              <div className="flex min-h-0 flex-1 flex-col max-md:h-56 max-md:flex-none">
                <FsEntryList
                  entries={browse.entries}
                  error={browse.ok ? null : browse.error}
                  loading={loading}
                  onNavigate={navigate}
                  onSelect={selectEntry}
                  selected={selected}
                />
              </div>
              <div
                className="flex min-h-0 w-[280px] shrink-0 flex-col gap-3 overflow-y-auto border-l p-4 max-md:w-full max-md:border-l-0 max-md:border-t max-md:overflow-visible"
                style={{ borderColor: 'var(--border)' }}
              >
                <FsSelectionPreview
                  onSuggestedNameChange={setName}
                  probe={probe}
                  suggestedName={name}
                />
                <ControllerModeSelect value={controllerMode} onChange={setControllerMode} />
                {!externalController && (
                  <WorkspaceCommandPresetSelect
                    error={commandPresetError ?? presetAvailabilityError}
                    onChange={onCommandPresetChange}
                    presets={commandPresets}
                    value={commandPresetId}
                  />
                )}
                {!externalController && (
                  <div
                    className="rounded-lg border overflow-hidden transition-all"
                    style={{
                      borderColor: 'var(--border)',
                      background: 'var(--bg-1)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setStartupExpanded((v) => !v)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-sec hover:bg-3 transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-1.5">
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
                        className="flex flex-col gap-2 border-t p-3 transition-all"
                        style={{
                          background: 'var(--bg-2)',
                          borderColor: 'var(--border)',
                        }}
                      >
                        <span className="text-xs font-medium uppercase tracking-wider text-ter">
                          {t('workspace.field.startup')}
                        </span>
                        <input
                          type="text"
                          value={startupCommand}
                          onChange={(event) => setStartupCommand(event.target.value)}
                          placeholder={t('workspace.field.startupPlaceholder')}
                          className="input mono text-sm max-md:text-base"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          inputMode="text"
                          data-testid="fs-startup-command"
                        />
                        <span className="text-xs normal-case tracking-normal text-ter leading-relaxed">
                          {t('workspace.startup.hintShort')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                )}

                <div
                  className="rounded-lg border overflow-hidden transition-all"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--bg-1)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setAdvanced((v) => !v)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-sec hover:bg-3 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-1.5">
                      <Sliders size={12} aria-hidden className="text-ter" />
                      {t('workspace.advanced.pastePath')}
                    </span>
                    {advanced ? (
                      <ChevronDown size={14} aria-hidden />
                    ) : (
                      <ChevronRight size={14} aria-hidden />
                    )}
                  </button>
                  {advanced ? (
                    <div
                      className="flex flex-col gap-2 border-t p-3 transition-all"
                      style={{
                        background: 'var(--bg-2)',
                        borderColor: 'var(--border)',
                      }}
                    >
                      <span className="text-xs font-medium uppercase tracking-wider text-ter">
                        {t('workspace.field.absolutePath')}
                      </span>
                      {manualHint ? (
                        <span
                          data-testid="fs-manual-hint"
                          className="text-xs normal-case tracking-normal text-ter leading-relaxed"
                        >
                          {manualHint}
                        </span>
                      ) : null}
                      <input
                        type="text"
                        value={manualPath}
                        onChange={(event) => setManualPath(event.target.value)}
                        placeholder={t('workspace.field.absolutePathPlaceholder')}
                        className="input mono text-sm max-md:text-base"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        inputMode="url"
                        data-testid="fs-manual-path"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div
              className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <button type="button" onClick={onClose} className="icon-btn">
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!canCreate}
                data-testid="add-workspace-create"
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
