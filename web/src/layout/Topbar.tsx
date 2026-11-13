import { Check, Copy, ExternalLink, ListChecks, Workflow } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import type { VersionInfo } from '../api.js'
import { useI18n } from '../i18n.js'
import { NotificationSettingsButton } from '../notifications/NotificationSettingsButton.js'
import { SettingsMenu } from '../settings/SettingsMenu.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useVersionInfo } from '../useVersionInfo.js'
import { APP_VERSION } from '../version.js'

type TopbarProps = {
  actions?: ReactNode
  hideActions?: boolean
  onToggleTaskGraph?: () => void
  openTaskCount?: number
  taskGraphOpen?: boolean
  onToggleWorkflows?: () => void
  workflowsOpen?: boolean
  version?: string
  versionInfo?: VersionInfo | null | undefined
}

export const Topbar = ({
  actions,
  hideActions = false,
  onToggleTaskGraph,
  openTaskCount = 0,
  taskGraphOpen = false,
  onToggleWorkflows,
  workflowsOpen = false,
  version = APP_VERSION,
  versionInfo: providedVersionInfo,
}: TopbarProps) => {
  const { t } = useI18n()
  const [copyState, setCopyState] = useState<'copied' | 'error' | 'idle'>('idle')
  const versionInfo = useVersionInfo(providedVersionInfo)
  const updateInfo =
    versionInfo?.updateAvailable && versionInfo.latestVersion !== version ? versionInfo : null
  const hasUpdateCommand = Boolean(updateInfo?.installHint)
  const hasOpenTasks = openTaskCount > 0
  const taskGraphTooltip = taskGraphOpen
    ? t('topbar.hideTodo')
    : hasOpenTasks
      ? t('topbar.todoOpen', { count: openTaskCount })
      : t('topbar.showTodo')
  const copyUpdateCommand = async () => {
    if (!updateInfo?.installHint) return
    try {
      await navigator.clipboard.writeText(updateInfo.installHint)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1600)
    } catch {
      setCopyState('error')
      window.setTimeout(() => setCopyState('idle'), 2200)
    }
  }
  const copyLabel =
    copyState === 'copied'
      ? t('topbar.updateCommandCopied')
      : copyState === 'error'
        ? t('topbar.updateCommandCopyFailed')
        : t('topbar.copyUpdateCommand')
  return (
    <header
      className="flex h-11 shrink-0 items-center px-4"
      style={{
        background: 'var(--bg-0)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <a
          href="https://hivehq.dev"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('topbar.openWebsite')}
          title={t('topbar.openWebsite')}
          className="-mx-1 flex items-center gap-2 rounded px-1 transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          data-testid="topbar-brand-link"
        >
          <img
            src="/logo.png"
            alt=""
            aria-hidden
            className="h-5 w-5 rounded-md"
            data-testid="topbar-logo"
          />
          <span className="font-semibold text-pri">Hive</span>
          <span className="text-ter text-xs tabular-nums">v{version}</span>
        </a>
        {updateInfo ? (
          <div
            className="flex min-w-0 items-center gap-1.5 text-xs"
            data-testid="topbar-update-badge"
          >
            <span
              className="rounded border px-2 py-0.5 font-medium"
              style={{
                background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
                borderColor: 'color-mix(in oklab, var(--accent) 30%, transparent)',
                color: 'var(--accent)',
              }}
            >
              {t('topbar.updateAvailable')}
            </span>
            <span className="hidden text-ter sm:inline">
              v{version} → v{updateInfo.latestVersion}
            </span>
            {hasUpdateCommand ? (
              <code
                className="mono hidden max-w-[18rem] truncate rounded border px-1.5 py-0.5 text-ter md:inline-block"
                title={updateInfo.updateNote || updateInfo.installHint}
                style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
              >
                {updateInfo.installHint}
              </code>
            ) : null}
            {updateInfo.updateNote ? (
              <span
                className="hidden max-w-[18rem] truncate text-ter xl:inline"
                title={updateInfo.updateNote}
              >
                {updateInfo.updateNote}
              </span>
            ) : null}
            {hasUpdateCommand ? (
              <Tooltip label={copyLabel}>
                <button
                  type="button"
                  onClick={copyUpdateCommand}
                  aria-label={copyLabel}
                  className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  data-testid="topbar-copy-update-command"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
                >
                  {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </Tooltip>
            ) : null}
            {updateInfo.releaseUrl ? (
              <Tooltip label={t('topbar.openRelease')}>
                <a
                  href={updateInfo.releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('topbar.openRelease')}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded border text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  data-testid="topbar-open-release"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
                >
                  <ExternalLink size={12} />
                </a>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex-1" />
      {hideActions ? null : (
        <div className="flex items-center gap-1">
          {actions}
          {onToggleTaskGraph ? (
            <Tooltip label={taskGraphTooltip}>
              <button
                type="button"
                onClick={onToggleTaskGraph}
                aria-pressed={taskGraphOpen}
                aria-label={taskGraphTooltip}
                data-has-tasks={hasOpenTasks ? 'true' : undefined}
                className="flex h-7 cursor-pointer items-center gap-1 rounded border px-2 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                data-testid="topbar-blueprint"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
              >
                <ListChecks size={13} className={hasOpenTasks ? 'text-accent' : undefined} />
                <span>{t('topbar.todo')}</span>
              </button>
            </Tooltip>
          ) : null}
          {onToggleWorkflows ? (
            <Tooltip label={workflowsOpen ? t('topbar.hideWorkflows') : t('topbar.showWorkflows')}>
              <button
                type="button"
                onClick={onToggleWorkflows}
                aria-pressed={workflowsOpen}
                aria-label={workflowsOpen ? t('topbar.hideWorkflows') : t('topbar.showWorkflows')}
                className="flex h-7 cursor-pointer items-center gap-1 rounded border px-2 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                data-testid="topbar-workflows"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
              >
                <Workflow size={13} />
                <span>{t('topbar.workflows')}</span>
              </button>
            </Tooltip>
          ) : null}
          <NotificationSettingsButton />
          <SettingsMenu />
        </div>
      )}
    </header>
  )
}
