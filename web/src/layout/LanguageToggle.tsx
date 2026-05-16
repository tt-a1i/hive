import { Languages } from 'lucide-react'

import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'

export const LanguageToggle = () => {
  const { language, setLanguage, t } = useI18n()
  const nextLanguage = language === 'en' ? 'zh' : 'en'
  const ariaLabel = nextLanguage === 'en' ? t('language.switchToEn') : t('language.switchToZh')
  const currentLabel = language === 'en' ? t('language.currentEn') : t('language.currentZh')

  return (
    <Tooltip label={ariaLabel}>
      <span>
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={() => setLanguage(nextLanguage)}
          className="flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
        >
          <Languages size={13} aria-hidden />
          <span>{currentLabel}</span>
        </button>
      </span>
    </Tooltip>
  )
}
