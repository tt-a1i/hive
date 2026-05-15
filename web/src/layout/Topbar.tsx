import { Hexagon, ListChecks } from 'lucide-react'

import type { VersionInfo } from '../api.js'
import { NotificationSettingsButton } from '../notifications/NotificationSettingsButton.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useVersionInfo } from '../useVersionInfo.js'
import { APP_VERSION } from '../version.js'

type TopbarProps = {
  hideActions?: boolean
  onToggleTaskGraph: () => void
  openTaskCount?: number
  taskGraphOpen: boolean
  version?: string
  versionInfo?: VersionInfo
}

export const Topbar = ({
  hideActions = false,
  onToggleTaskGraph,
  openTaskCount = 0,
  taskGraphOpen,
  version = APP_VERSION,
  versionInfo: providedVersionInfo,
}: TopbarProps) => {
  const versionInfo = useVersionInfo(providedVersionInfo)
  const updateInfo =
    versionInfo?.updateAvailable && versionInfo.latestVersion !== version ? versionInfo : null
  const hasOpenTasks = openTaskCount > 0
  const tooltipLabel = taskGraphOpen
    ? 'Hide Todo'
    : hasOpenTasks
      ? `Todo — ${openTaskCount} open task${openTaskCount === 1 ? '' : 's'}`
      : 'Show Todo (.hive/tasks.md)'
  return (
    <header
      className="flex h-11 shrink-0 items-center px-4"
      style={{
        background: 'var(--bg-0)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="flex items-center gap-2">
        <Hexagon size={16} className="text-pri" aria-hidden />
        <span className="font-semibold text-pri">Hive</span>
        <span className="text-ter text-xs tabular-nums">v{version}</span>
        {updateInfo ? (
          <div className="flex items-center gap-2 text-xs" data-testid="topbar-update-badge">
            <span
              className="rounded border px-2 py-0.5 font-medium"
              style={{
                background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
                borderColor: 'color-mix(in oklab, var(--accent) 30%, transparent)',
                color: 'var(--accent)',
              }}
            >
              Update available
            </span>
            <span className="text-ter">
              v{version} → v{updateInfo.latestVersion}
            </span>
            <code className="mono text-ter">{updateInfo.installHint}</code>
          </div>
        ) : null}
      </div>
      <div className="flex-1" />
      {hideActions ? null : (
        <div className="flex items-center gap-1">
          <Tooltip label={tooltipLabel}>
            <button
              type="button"
              onClick={onToggleTaskGraph}
              aria-pressed={taskGraphOpen}
              aria-label="Toggle Todo"
              data-has-tasks={hasOpenTasks ? 'true' : undefined}
              className="flex cursor-pointer items-center gap-1.5 rounded px-3 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
              data-testid="topbar-blueprint"
            >
              <ListChecks
                size={14}
                aria-hidden
                /* Light up when there are open tasks so the icon reads as
                   "you have something to look at" without a separate
                   badge. text-accent on a dim button is enough; bumping
                   the surrounding text would be too loud. */
                className={hasOpenTasks ? 'text-accent' : undefined}
              />
              <span>Todo</span>
            </button>
          </Tooltip>
          <NotificationSettingsButton />
        </div>
      )}
    </header>
  )
}
