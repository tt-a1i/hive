import type { ReactNode } from 'react'

import type { VersionInfo } from '../api.js'
import { useI18n } from '../i18n.js'
import { NotificationSettingsButton } from '../notifications/NotificationSettingsButton.js'
import { useVersionInfo } from '../useVersionInfo.js'
import { APP_VERSION } from '../version.js'
import { LanguageToggle } from './LanguageToggle.js'
import { ThemeToggle } from './ThemeToggle.js'

type TopbarProps = {
  actions?: ReactNode | undefined
  hideActions?: boolean | undefined
  version?: string | undefined
  versionInfo?: VersionInfo | undefined
}

export const Topbar = ({
  actions,
  hideActions = false,
  version = APP_VERSION,
  versionInfo: providedVersionInfo,
}: TopbarProps) => {
  const { t } = useI18n()
  const versionInfo = useVersionInfo(providedVersionInfo)
  const updateInfo =
    versionInfo?.updateAvailable && versionInfo.latestVersion !== version ? versionInfo : null
  return (
    <header
      className="flex h-11 shrink-0 items-center px-4"
      style={{
        background: 'var(--bg-0)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="flex items-center gap-2">
        <img
          src="/logo.png"
          alt=""
          aria-hidden
          className="h-5 w-5 rounded-md"
          data-testid="topbar-logo"
        />
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
              {t('topbar.updateAvailable')}
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
          {actions}
          <ThemeToggle />
          <LanguageToggle />
          <NotificationSettingsButton />
        </div>
      )}
    </header>
  )
}
