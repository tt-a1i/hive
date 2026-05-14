import { Hexagon, ListChecks } from 'lucide-react'

import { NotificationSettingsButton } from '../notifications/NotificationSettingsButton.js'
import { APP_VERSION } from '../version.js'

type TopbarProps = {
  hideActions?: boolean
  onToggleTaskGraph: () => void
  taskGraphOpen: boolean
  version?: string
}

export const Topbar = ({
  hideActions = false,
  onToggleTaskGraph,
  taskGraphOpen,
  version = APP_VERSION,
}: TopbarProps) => (
  <header
    className="flex h-11 shrink-0 items-center px-4"
    style={{
      background: 'var(--bg-0)',
      borderBottom: '1px solid var(--border-bright)',
    }}
  >
    <div className="flex items-center gap-2">
      <Hexagon size={16} className="text-pri" aria-hidden />
      <span className="font-semibold text-pri">Hive</span>
      <span className="text-ter text-xs">v{version}</span>
    </div>
    <div className="flex-1" />
    {hideActions ? null : (
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
    )}
  </header>
)
