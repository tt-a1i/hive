import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'

import { FsEntryList } from './FsEntryList.js'
import { FsSelectionPreview } from './FsSelectionPreview.js'
import { buildBreadcrumbs } from './path-breadcrumbs.js'
import { useFsBrowser } from './useFsBrowser.js'

type ServerBrowseDialogProps = {
  onClose: () => void
  onCreate: (input: { name: string; path: string }) => void
  open: boolean
}

/**
 * Server-side filesystem browser dialog — the kanban-style "remote" picker.
 * Served via the `▸ Advanced: browse server filesystem` affordance on the
 * compact confirm dialog. The **default** workspace-add flow is the native
 * OS folder picker (`pickFolder()`); this surface exists for SSH / headless
 * runtime scenarios where no OS dialog is available.
 */
export const ServerBrowseDialog = ({ onClose, onCreate, open }: ServerBrowseDialogProps) => {
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
    onCreate({ name: name.trim(), path })
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      data-testid="add-workspace-dialog"
    >
      <button
        type="button"
        aria-label="Close add workspace"
        onClick={onClose}
        className="modal-backdrop absolute inset-0"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Browse server filesystem"
        className="relative flex w-[720px] max-w-[90vw] flex-col rounded-lg border shadow-2xl"
        style={{ height: '560px', background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <Folder size={16} aria-hidden className="text-sec" />
          <h2 className="font-medium text-pri">Browse server filesystem</h2>
          <span className="mono truncate text-[11px] text-ter" data-testid="fs-root-path">
            root: {browse.root_path || '(loading)'}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="px-2 text-lg leading-none text-sec hover:text-pri"
          >
            ×
          </button>
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
            className="rounded px-2 py-0.5 text-sec hover:bg-3 hover:text-pri disabled:opacity-40"
          >
            ↑ up
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
            className="flex w-[260px] shrink-0 flex-col gap-3 border-l p-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <FsSelectionPreview
              onSuggestedNameChange={setName}
              probe={probe}
              suggestedName={name}
            />
            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className="text-left text-[10px] uppercase tracking-wider text-ter hover:text-sec"
            >
              {advanced ? '▾ Advanced: paste path' : '▸ Advanced: paste path'}
            </button>
            {advanced ? (
              <label className="flex flex-col gap-1 text-[11px] text-ter">
                Absolute path
                <input
                  type="text"
                  value={manualPath}
                  onChange={(event) => setManualPath(event.target.value)}
                  placeholder="/absolute/path"
                  className="mono rounded border px-2 py-1 text-sm text-pri"
                  style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
                  data-testid="fs-manual-path"
                />
              </label>
            ) : null}
          </div>
        </div>

        <div
          className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-sec hover:bg-3 hover:text-pri"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!canCreate}
            data-testid="add-workspace-create"
            className="rounded px-4 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
            style={{ background: 'var(--accent)' }}
          >
            Create Workspace
          </button>
        </div>
      </div>
    </div>
  )
}
