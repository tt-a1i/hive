import { Sparkles } from 'lucide-react'

import { useI18n } from '../i18n.js'

export const DemoBanner = ({ onExit }: { onExit: () => void }) => {
  const { t } = useI18n()
  return (
    <section
      aria-label="Demo mode"
      data-testid="demo-banner"
      className="flex shrink-0 items-center justify-between border-b px-4 py-2 text-xs"
      style={{ background: 'var(--status-yellow-bg, #3a2c1c)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-2 text-pri">
        <Sparkles size={14} aria-hidden />
        <span>{t('demo.banner')}</span>
      </div>
      <button type="button" onClick={onExit} className="icon-btn icon-btn--ghost">
        {t('demo.exit')}
      </button>
    </section>
  )
}
