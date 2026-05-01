import { Hexagon, ListChecks } from 'lucide-react'

import { NotificationSettingsButton } from '../notifications/NotificationSettingsButton.js'

type TopbarProps = {
  onToggleTaskGraph: () => void
  taskGraphOpen: boolean
  version?: string
}

export const Topbar = ({ onToggleTaskGraph, taskGraphOpen, version = 'v0.1' }: TopbarProps) => (
  <header
    className="flex h-11 shrink-0 items-center border-b px-4"
    style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
  >
    <div className="flex items-center gap-2">
      <Hexagon size={16} className="text-pri" aria-hidden />
      <span className="font-semibold text-pri">Hive</span>
      <span className="text-ter text-xs">{version}</span>
    </div>
    <div className="flex-1" />
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onToggleTaskGraph}
        aria-pressed={taskGraphOpen}
        aria-label="Toggle blueprint"
        className="flex items-center gap-1.5 rounded px-3 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
        data-testid="topbar-blueprint"
      >
        <ListChecks size={14} aria-hidden />
        <span>Blueprint</span>
      </button>
      <NotificationSettingsButton />
    </div>
  </header>
)
