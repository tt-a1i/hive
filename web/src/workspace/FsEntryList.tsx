import { Folder, GitBranch } from 'lucide-react'

import type { FsBrowseEntryPayload } from '../api.js'

type FsEntryListProps = {
  entries: FsBrowseEntryPayload[]
  error: string | null
  loading: boolean
  onNavigate: (path: string) => void
  onSelect: (path: string) => void
  selected: string | null
}

export const FsEntryList = ({
  entries,
  error,
  loading,
  onNavigate,
  onSelect,
  selected,
}: FsEntryListProps) => (
  <div
    className="scroll-y min-h-[200px] flex-1 border-t border-b"
    style={{ borderColor: 'var(--border)' }}
    data-testid="fs-entry-list"
  >
    {loading ? (
      <p className="p-4 text-center text-xs text-ter">Loading…</p>
    ) : error ? (
      <p
        className="p-4 text-center text-xs"
        style={{ color: 'var(--status-red)' }}
        data-testid="fs-browse-error"
      >
        {error}
      </p>
    ) : entries.length === 0 ? (
      <p className="p-4 text-center text-xs text-ter">This directory is empty.</p>
    ) : (
      <ul>
        {entries.map((entry) => {
          const isSelected = selected === entry.path
          return (
            <li key={entry.path} className="flex items-center gap-0">
              <button
                type="button"
                data-testid={`fs-entry-${entry.name}`}
                onClick={() => onSelect(entry.path)}
                onDoubleClick={() => onNavigate(entry.path)}
                className="flex flex-1 items-center gap-2 px-3 py-2 text-left text-xs hover:bg-3"
                style={
                  isSelected
                    ? { background: 'var(--bg-3)', color: 'var(--text-primary)' }
                    : { color: 'var(--text-primary)' }
                }
              >
                <span aria-hidden className="inline-flex items-center text-sec">
                  {entry.is_git_repository ? <GitBranch size={14} /> : <Folder size={14} />}
                </span>
                <span className="mono flex-1 truncate">{entry.name}</span>
                {entry.is_git_repository ? (
                  <span
                    className="text-[10px] uppercase tracking-wider"
                    style={{ color: 'var(--accent)' }}
                  >
                    git
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                data-testid={`fs-entry-open-${entry.name}`}
                onClick={() => onNavigate(entry.path)}
                aria-label={`Open ${entry.name}`}
                className="px-3 py-2 text-xs text-ter hover:text-pri"
              >
                →
              </button>
            </li>
          )
        })}
      </ul>
    )}
  </div>
)
