import { AlertTriangle, ArrowRight, FolderPlus, Send, Users } from 'lucide-react'
import type { ReactNode } from 'react'

import { type TranslationKey, useI18n } from '../i18n.js'

type WelcomePaneProps = {
  onAddWorkspace: () => void
  onTryDemo?: () => void
  heroImageSrc?: string
  /**
   * When true, the primary CTA is disabled and a "runtime offline" footnote
   * appears. Used by App.tsx when the local Hive runtime bootstrap failed.
   */
  disabledReason?: string
}

const STEPS: Array<{ descriptionKey: TranslationKey; icon: ReactNode; titleKey: TranslationKey }> =
  [
    {
      icon: <FolderPlus size={16} />,
      titleKey: 'welcome.step1Title',
      descriptionKey: 'welcome.step1Desc',
    },
    {
      icon: <Users size={16} />,
      titleKey: 'welcome.step2Title',
      descriptionKey: 'welcome.step2Desc',
    },
    {
      icon: <Send size={16} />,
      titleKey: 'welcome.step3Title',
      descriptionKey: 'welcome.step3Desc',
    },
  ]

export const WelcomePane = ({
  onAddWorkspace,
  onTryDemo,
  heroImageSrc,
  disabledReason,
}: WelcomePaneProps) => {
  const { t } = useI18n()
  const disabled = Boolean(disabledReason)
  return (
    <div
      data-testid="welcome-pane"
      className="m-auto flex w-full flex-col items-center gap-6 px-6 py-12 text-center"
      style={{ maxWidth: '540px' }}
    >
      {heroImageSrc ? <img src={heroImageSrc} alt="" className="h-24 w-24" aria-hidden /> : null}
      <div className="space-y-2">
        <div className="text-2xl font-semibold text-pri">{t('welcome.title')}</div>
        <div className="text-sm text-sec">{t('welcome.desc')}</div>
      </div>
      <ol className="grid w-full grid-cols-3 gap-3 text-left">
        {STEPS.map((step, idx) => (
          <li
            key={step.titleKey}
            className="rounded border bg-1 p-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="mb-1 flex items-center gap-2 text-pri">
              <span className="font-medium text-xs text-ter">{idx + 1}</span>
              {step.icon}
            </div>
            <div className="text-xs font-medium text-pri">{t(step.titleKey)}</div>
            <div className="mt-1 text-xs text-ter">{t(step.descriptionKey)}</div>
          </li>
        ))}
      </ol>
      {disabled ? (
        <div
          role="alert"
          data-testid="welcome-pane-disabled-reason"
          className="flex items-start gap-2 rounded px-3 py-2 text-left text-xs"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--status-red) 28%, transparent)',
            color: 'var(--status-red)',
          }}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span className="break-words">{disabledReason}</span>
        </div>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={disabled ? undefined : onAddWorkspace}
        aria-disabled={disabled || undefined}
        title={disabledReason}
        className="icon-btn icon-btn--primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="welcome-pane-add"
      >
        <span>{t('welcome.addWorkspace')}</span>
        <ArrowRight size={14} aria-hidden />
      </button>
      {onTryDemo ? (
        <button
          type="button"
          onClick={onTryDemo}
          className="text-xs text-sec underline hover:text-pri"
        >
          {t('welcome.demo')}
        </button>
      ) : null}
    </div>
  )
}
