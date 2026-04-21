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
      <span className="text-lg leading-none">🐝</span>
      <span className="font-semibold text-pri">Hive</span>
      <span className="text-ter text-xs">{version}</span>
    </div>
    <div className="flex-1" />
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onToggleTaskGraph}
        aria-pressed={taskGraphOpen}
        aria-label="Toggle task graph"
        className="flex items-center gap-1 rounded px-3 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
      >
        <span aria-hidden>📋</span>
        <span>Task Graph</span>
      </button>
      <button
        type="button"
        aria-label="Settings"
        className="rounded px-3 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
      >
        <span aria-hidden>⚙️</span>
        <span className="ml-1">Settings</span>
      </button>
    </div>
  </header>
)
