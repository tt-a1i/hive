import { Languages } from 'lucide-react'

import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import type { UiLanguage } from '../uiLanguage.js'

const LANGUAGES: UiLanguage[] = ['en', 'zh']

export const LanguageToggle = () => {
  const { language, setLanguage, t } = useI18n()

  return (
    <fieldset
      aria-label={t('language.aria')}
      className="flex items-center gap-0.5 rounded border p-0.5"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
    >
      <Tooltip label={t('language.tooltip')}>
        <span className="flex h-6 w-6 items-center justify-center text-ter">
          <Languages size={13} aria-hidden />
        </span>
      </Tooltip>
      {LANGUAGES.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={language === value}
          onClick={() => setLanguage(value)}
          className="rounded px-1.5 py-0.5 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri aria-pressed:bg-3 aria-pressed:text-pri"
        >
          {t(value === 'en' ? 'language.en' : 'language.zh')}
        </button>
      ))}
    </fieldset>
  )
}
