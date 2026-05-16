import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUp, ChevronDown, ChevronRight, Folder, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { CommandPreset } from '../api.js'
import { FsEntryList } from './FsEntryList.js'
import { FsSelectionPreview } from './FsSelectionPreview.js'
import { buildBreadcrumbs } from './path-breadcrumbs.js'
import { useFsBrowser } from './useFsBrowser.js'
import { WorkspaceCommandPresetSelect } from './WorkspaceCommandPresetSelect.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

type ServerBrowseDialogProps = {
  commandPresetError: string | null
  commandPresetId: string
  commandPresetTouched: boolean
  commandPresets: CommandPreset[]
  onClose: () => void
  onCommandPresetChange: (value: string) => void
  onCreate: (input: WorkspaceCreateInput) => void
  open: boolean
}

/**
 * Server-side filesystem browser dialog — the kanban-style "remote" picker.
 * Served via the `▸ Advanced: browse server filesystem` affordance on the
 * compact confirm dialog. The **default** workspace-add flow is the native
 * OS folder picker (`pickFolder()`); this surface exists for SSH / headless
 * runtime scenarios where no OS dialog is available.
 */
export const ServerBrowseDialog = ({
  commandPresetError,
  commandPresetId,
  commandPresetTouched,
  commandPresets,
  onClose,
  onCommandPresetChange,
  onCreate,
  open,
}: ServerBrowseDialogProps) => {
  const { browse, loading, navigate, probe, selectEntry, selected } = useFsBrowser(open)
  const [name, setName] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const [startupExpanded, setStartupExpanded] = useState(false)
  const [startupCommand, setStartupCommand] = useState('')

  useEffect(() => {
    if (!open) {
      setName('')
      setAdvanced(false)
      setManualPath('')
      setStartupExpanded(false)
      setStartupCommand('')
    }
  }, [open])

  useEffect(() => {
    if (probe?.suggested_name) setName(probe.suggested_name)
  }, [probe?.suggested_name])

  if (!open) return null

  const breadcrumbs = buildBreadcrumbs(browse.current_path, browse.root_path)
  const selectedPreset = commandPresets.find((preset) => preset.id === commandPresetId)
  const startupClean = startupCommand.trim()
  const presetsLoading = commandPresets.length === 0 && !commandPresetError
  const selectedPresetUnavailable = selectedPreset?.available === false && startupClean.length === 0
  const presetAvailabilityError = selectedPresetUnavailable
    ? `${selectedPreset.displayName} is not installed. Choose another CLI or add a custom startup command.`
    : null
  const canCreate =
    name.trim().length > 0 &&
    (probe?.is_dir === true || (advanced && manualPath.trim().length > 0)) &&
    !presetsLoading &&
    !selectedPresetUnavailable

  const handleCreate = () => {
    const path = advanced && manualPath.trim().length > 0 ? manualPath.trim() : (probe?.path ?? '')
    if (!path) return
    onCreate({
      commandPresetId: startupClean && !commandPresetTouched ? null : commandPresetId || null,
      name: name.trim(),
      path,
      ...(startupClean ? { startupCommand: startupClean } : {}),
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="server-browse-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        {/* Grid place-items-center is more robust than transform-based */}
        {/* centering when the document has containment contexts (e.g. the */}
        {/* sidebar's container-type) that can shift the fixed positioning */}
        {/* containing-block. Mirrors ConfirmWorkspaceDialog. */}
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="add-workspace-dialog"
            className="dialog-scale-pop elev-2 pointer-events-auto flex w-[760px] max-w-[calc(100vw-32px)] flex-col rounded-lg border"
            style={{
              height: 'min(600px, calc(100vh - 64px))',
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
                  Browse server filesystem
                </Dialog.Title>
                <Dialog.Description
                  className="mono truncate text-xs text-ter"
                  data-testid="fs-root-path"
                >
                  root: {browse.root_path || '(loading)'}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close dialog"
                  className="flex h-7 w-7 items-center justify-center rounded text-sec hover:bg-3 hover:text-pri"
                >
                  <X size={14} aria-hidden />
                </button>
              </Dialog.Close>
            </div>

            <nav
              className="flex shrink-0 items-center gap-1 border-b px-4 py-2 text-xs"
              style={{ borderColor: 'var(--border)' }}
              aria-label="Breadcrumb"
              data-testid="fs-breadcrumb"
            >
              <button
                type="button"
                onClick={() => (browse.parent_path ? navigate(browse.parent_path) : null)}
                disabled={!browse.parent_path}
                aria-label="Go to parent directory"
                className="flex items-center gap-1 rounded px-2 py-0.5 text-sec hover:bg-3 hover:text-pri disabled:opacity-40"
              >
                <ArrowUp size={12} aria-hidden /> up
              </button>
              <div className="mx-2 h-4 w-px" style={{ background: 'var(--border)' }} />
              {breadcrumbs.map((segment, index) => {
                const isLast = index === breadcrumbs.length - 1
                return (
                  <span key={segment.path} className="flex items-center gap-0.5">
                    {index > 0 ? <span className="text-ter">/</span> : null}
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

            <div className="flex min-h-0 flex-1">
              <div className="flex min-h-0 flex-1 flex-col">
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
                className="flex w-[280px] shrink-0 flex-col gap-3 border-l p-4"
                style={{ borderColor: 'var(--border)' }}
              >
                <FsSelectionPreview
                  onSuggestedNameChange={setName}
                  probe={probe}
                  suggestedName={name}
                />
                <WorkspaceCommandPresetSelect
                  error={commandPresetError ?? presetAvailabilityError}
                  onChange={onCommandPresetChange}
                  presets={commandPresets}
                  value={commandPresetId}
                />
                <button
                  type="button"
                  onClick={() => setStartupExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-left text-xs uppercase tracking-wider text-ter hover:text-sec"
                >
                  {startupExpanded ? (
                    <ChevronDown size={12} aria-hidden />
                  ) : (
                    <ChevronRight size={12} aria-hidden />
                  )}
                  Advanced: startup command
                </button>
                {startupExpanded ? (
                  <label className="flex flex-col gap-2 text-xs uppercase tracking-wider text-ter">
                    Startup command
                    <input
                      type="text"
                      value={startupCommand}
                      onChange={(event) => setStartupCommand(event.target.value)}
                      placeholder="claude --resume <session-id>"
                      className="input mono"
                      data-testid="fs-startup-command"
                    />
                    <span className="text-xs normal-case tracking-normal text-ter">
                      Runs through your login shell in the workspace directory. Only paste commands
                      you trust.
                    </span>
                  </label>
                ) : null}
                <button
                  type="button"
                  onClick={() => setAdvanced((v) => !v)}
                  className="flex items-center gap-1.5 text-left text-xs uppercase tracking-wider text-ter hover:text-sec"
                >
                  {advanced ? (
                    <ChevronDown size={12} aria-hidden />
                  ) : (
                    <ChevronRight size={12} aria-hidden />
                  )}
                  Advanced: paste path
                </button>
                {advanced ? (
                  <label className="flex flex-col gap-2 text-xs uppercase tracking-wider text-ter">
                    Absolute path
                    <input
                      type="text"
                      value={manualPath}
                      onChange={(event) => setManualPath(event.target.value)}
                      placeholder="/absolute/path"
                      className="input mono"
                      data-testid="fs-manual-path"
                    />
                  </label>
                ) : null}
              </div>
            </div>

            <div
              className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <button type="button" onClick={onClose} className="icon-btn">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!canCreate}
                data-testid="add-workspace-create"
                className="icon-btn icon-btn--primary"
              >
                Create workspace
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
