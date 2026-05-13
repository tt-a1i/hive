import { Sparkles } from 'lucide-react'

export const DemoBanner = ({ onExit }: { onExit: () => void }) => (
  <section
    aria-label="Demo mode"
    data-testid="demo-banner"
    className="flex shrink-0 items-center justify-between border-b px-4 py-2 text-xs"
    style={{ background: 'var(--status-yellow-bg, #3a2c1c)', borderColor: 'var(--border)' }}
  >
    <div className="flex items-center gap-2 text-pri">
      <Sparkles size={13} aria-hidden />
      <span>
        <strong>DEMO MODE</strong> — agents are pre-recorded, not running.
      </span>
    </div>
    <button type="button" onClick={onExit} className="icon-btn icon-btn--ghost">
      Exit Demo
    </button>
  </section>
)
