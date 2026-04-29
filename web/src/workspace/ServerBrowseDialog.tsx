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

  useEffect(() => {
    if (!open) {
      setName('')
      setAdvanced(false)
      setManualPath('')
    }
  }, [open])

  useEffect(() => {
    if (probe?.suggested_name) setName(probe.suggested_name)
  }, [probe?.suggested_name])

  if (!open) return null

  const breadcrumbs = buildBreadcrumbs(browse.current_path, browse.root_path)
  const canCreate =
    name.trim().length > 0 && (probe?.is_dir === true || (advanced && manualPath.trim().length > 0))

  const handleCreate = () => {
    const path = advanced && manualPath.trim().length > 0 ? manualPath.trim() : (probe?.path ?? '')
    if (!path) return
    onCreate({ commandPresetId: commandPresetId || null, name: name.trim(), path })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="server-browse-overlay"
          className="fixed inset-0 z-40"
          style={{ background: 'var(--bg-overlay)' }}
        />
        <Dialog.Content
          data-testid="add-workspace-dialog"
          className="fixed top-1/2 left-1/2 z-50 flex w-[760px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border"
          style={{
            height: '600px',
            maxHeight: 'calc(100vh - 32px)',
            background: 'var(--bg-elevated)',
            borderColor: 'var(--border-bright)',
            boxShadow: 'var(--shadow-elev-2)',
          }}
        >
          <div
            className="flex shrink-0 items-center gap-3 border-b px-5 py-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{
                background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                color: 'var(--accent)',
              }}
            >
              <Folder size={18} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-md font-medium text-pri">
                Browse server filesystem
              </Dialog.Title>
              <Dialog.Description
                className="mono truncate text-[11px] text-ter"
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
              <ArrowUp size={11} aria-hidden /> up
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
                error={commandPresetError}
                onChange={onCommandPresetChange}
                presets={commandPresets}
                value={commandPresetId}
              />
              <button
                type="button"
                onClick={() => setAdvanced((v) => !v)}
                className="flex items-center gap-1.5 text-left text-[10px] uppercase tracking-wider text-ter hover:text-sec"
              >
                {advanced ? (
                  <ChevronDown size={11} aria-hidden />
                ) : (
                  <ChevronRight size={11} aria-hidden />
                )}
                Advanced: paste path
              </button>
              {advanced ? (
                <label className="flex flex-col gap-1.5 text-[10px] uppercase tracking-wider text-ter">
                  Absolute path
                  <input
                    type="text"
                    value={manualPath}
                    onChange={(event) => setManualPath(event.target.value)}
                    placeholder="/absolute/path"
                    className="mono rounded-md border px-3 py-2 text-sm text-pri outline-none"
                    style={{
                      background: 'var(--bg-1)',
                      borderColor: 'var(--border-bright)',
                    }}
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
      </Dialog.Portal>
    </Dialog.Root>
  )
}
