import { ArrowRight, FolderPlus, Send, Users } from 'lucide-react'
import type { ReactNode } from 'react'

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

const STEPS: Array<{ icon: ReactNode; title: string; description: string }> = [
  {
    icon: <FolderPlus size={16} />,
    title: 'Add a workspace',
    description: 'Pick a project folder.',
  },
  {
    icon: <Users size={16} />,
    title: 'Choose an Orchestrator',
    description: 'Claude / Codex / Gemini / OpenCode.',
  },
  {
    icon: <Send size={16} />,
    title: 'Dispatch tasks',
    description: 'The Orchestrator routes work via team send.',
  },
]

export const WelcomePane = ({
  onAddWorkspace,
  onTryDemo,
  heroImageSrc,
  disabledReason,
}: WelcomePaneProps) => {
  const disabled = Boolean(disabledReason)
  return (
    <div
      data-testid="welcome-pane"
      className="m-auto flex w-full flex-col items-center gap-6 px-6 py-12 text-center"
      style={{ maxWidth: '540px' }}
    >
      {heroImageSrc ? <img src={heroImageSrc} alt="" className="h-24 w-24" aria-hidden /> : null}
      <div className="space-y-2">
        <div className="text-2xl font-semibold text-pri">Welcome to Hive</div>
        <div className="text-sm text-sec">
          Coordinate Claude Code, Codex, Gemini, OpenCode — locally.
        </div>
      </div>
      <ol className="grid w-full grid-cols-3 gap-3 text-left">
        {STEPS.map((step, idx) => (
          <li
            key={step.title}
            className="rounded border bg-1 p-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="mb-1 flex items-center gap-2 text-pri">
              <span className="font-medium text-xs text-ter">{idx + 1}</span>
              {step.icon}
            </div>
            <div className="text-xs font-medium text-pri">{step.title}</div>
            <div className="mt-1 text-xs text-ter">{step.description}</div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        disabled={disabled}
        onClick={disabled ? undefined : onAddWorkspace}
        aria-disabled={disabled || undefined}
        title={disabledReason}
        className="icon-btn icon-btn--primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="welcome-pane-add"
      >
        <span>Add your first workspace</span>
        <ArrowRight size={14} aria-hidden />
      </button>
      {disabled ? (
        <div className="text-xs text-status-red" data-testid="welcome-pane-disabled-reason">
          {disabledReason}
        </div>
      ) : null}
      {onTryDemo ? (
        <button
          type="button"
          onClick={onTryDemo}
          className="text-xs text-sec underline hover:text-pri"
        >
          or try the demo (no install needed)
        </button>
      ) : null}
    </div>
  )
}
