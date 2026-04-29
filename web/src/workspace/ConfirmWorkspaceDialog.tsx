import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { FsProbeResponse } from '../api.js'

type ConfirmWorkspaceDialogProps = {
  /** Probe result for the picked folder, or null when user chose the paste-path fallback. */
  probe: FsProbeResponse | null
  /** When true, the paste-path fallback section is expanded by default (unsupported platform). */
  pasteFallbackDefault?: boolean
  onCancel: () => void
  onCreate: (input: { name: string; path: string }) => void
  onOpenServerBrowse: () => void
}

const basenameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? ''

export const ConfirmWorkspaceDialog = ({
  probe,
  pasteFallbackDefault = false,
  onCancel,
  onCreate,
  onOpenServerBrowse,
}: ConfirmWorkspaceDialogProps) => {
  const initialPath = probe?.path ?? ''
  const initialName = probe?.suggested_name ?? basenameOf(initialPath)
  const [name, setName] = useState(initialName)
  const [pastePath, setPastePath] = useState('')
  const [pasteExpanded, setPasteExpanded] = useState(pasteFallbackDefault)

  // Re-sync when the probe changes (user re-picks a folder without closing).
  useEffect(() => {
    setName(probe?.suggested_name ?? basenameOf(probe?.path ?? ''))
  }, [probe?.path, probe?.suggested_name])

  const pastedClean = pastePath.trim()
  const resolvedPath = pasteExpanded && pastedClean.length > 0 ? pastedClean : (probe?.path ?? '')
  const canCreate = name.trim().length > 0 && resolvedPath.length > 0

  const handleCreate = () => {
    if (!canCreate) return
    onCreate({ name: name.trim(), path: resolvedPath })
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      data-testid="confirm-workspace-dialog"
    >
      <button
        type="button"
        aria-label="Close add workspace"
        onClick={onCancel}
        className="modal-backdrop absolute inset-0"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm workspace"
        className="relative flex w-[460px] max-w-[90vw] flex-col rounded-lg border shadow-2xl"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <div
          className="flex items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <Folder size={16} aria-hidden className="text-sec" />
          <h2 className="font-medium text-pri">Add workspace</h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close dialog"
            className="px-2 text-lg leading-none text-sec hover:text-pri"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-ter">
            Path
            <input
              readOnly
              value={probe?.path ?? ''}
              placeholder="(no folder picked — use paste path below)"
              className="mono rounded border px-2 py-1.5 text-sm text-pri"
              style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
              data-testid="confirm-workspace-path"
            />
          </label>

          {probe?.is_git_repository ? (
            <div
              className="flex items-center gap-2 text-[11px]"
              data-testid="confirm-workspace-git-badge"
            >
              <span className="role-badge role-badge--coder" style={{ fontSize: '9px' }}>
                git · {probe.current_branch ?? 'detached'}
              </span>
              <span className="text-ter">Git repo detected</span>
            </div>
          ) : probe?.ok ? (
            <span className="text-[11px] text-ter">No git repository at this path.</span>
          ) : null}

          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-ter">
            Workspace name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mono rounded border px-2 py-1.5 text-sm text-pri"
              style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
              data-testid="confirm-workspace-name"
            />
          </label>

          <button
            type="button"
            onClick={() => setPasteExpanded((v) => !v)}
            className="text-left text-[10px] uppercase tracking-wider text-ter hover:text-sec"
            data-testid="confirm-workspace-paste-toggle"
          >
            {pasteExpanded ? '▾ Advanced: paste path' : '▸ Advanced: paste path'}
          </button>
          {pasteExpanded ? (
            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-ter">
              Absolute path
              <input
                type="text"
                value={pastePath}
                onChange={(event) => setPastePath(event.target.value)}
                placeholder="/absolute/path"
                className="mono rounded border px-2 py-1.5 text-sm text-pri"
                style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
                data-testid="confirm-workspace-paste-path"
              />
            </label>
          ) : null}

          <button
            type="button"
            onClick={onOpenServerBrowse}
            className="text-left text-[10px] uppercase tracking-wider text-ter hover:text-sec"
            data-testid="confirm-workspace-browse-toggle"
          >
            ▸ Advanced: browse server filesystem
          </button>
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs text-sec hover:bg-3 hover:text-pri"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!canCreate}
            data-testid="confirm-workspace-create"
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
