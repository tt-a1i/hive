type Props = { visible: boolean; onDismiss: () => void }

export const OrchestratorHintOverlay = ({ visible, onDismiss }: Props) => {
  if (!visible) return null

  return (
    <div
      data-testid="orch-hint"
      className="absolute bottom-4 right-4 z-10 flex max-w-[340px] flex-col gap-2 rounded-lg border bg-2 p-3"
      style={{ borderColor: 'var(--border-bright)', boxShadow: 'var(--shadow-elev-2)' }}
    >
      <div className="text-xs font-semibold text-pri">Try saying</div>
      <div
        className="mono rounded px-2 py-1 text-xs text-sec"
        style={{ background: 'var(--bg-3)' }}
      >
        Help me write a hello world to /tmp/hello.js
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-ter">Just type below — the terminal is live.</span>
        <button
          type="button"
          className="icon-btn shrink-0"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
