export type OrchestratorPaneState =
  | { kind: 'idle' }
  | { kind: 'running'; runId: string }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  agentModel?: string
  state: OrchestratorPaneState
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}

const HeaderActions = ({
  state,
  onStop,
  onRestart,
}: Pick<OrchestratorPaneProps, 'state' | 'onStop' | 'onRestart'>) => {
  if (state.kind === 'running') {
    return (
      <div className="flex gap-1" data-testid="orchestrator-running-actions">
        <button
          type="button"
          onClick={onStop}
          className="rounded px-2 py-0.5 text-[11px] text-sec hover:bg-3 hover:text-pri"
          style={{ borderColor: 'var(--border)' }}
          data-testid="orchestrator-stop"
        >
          ⏹ Stop
        </button>
        <button
          type="button"
          onClick={onRestart}
          className="rounded px-2 py-0.5 text-[11px] text-sec hover:bg-3 hover:text-pri"
          data-testid="orchestrator-restart"
        >
          ↻ Restart
        </button>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <button
        type="button"
        onClick={onRestart}
        className="rounded px-2 py-0.5 text-[11px] text-white hover:opacity-90"
        style={{ background: 'var(--accent)' }}
        data-testid="orchestrator-retry-header"
      >
        ↻ Retry
      </button>
    )
  }
  return null
}

const PlaceholderBody = ({
  state,
  onStart,
  onRestart,
}: Pick<OrchestratorPaneProps, 'state' | 'onStart' | 'onRestart'>) => {
  if (state.kind === 'failed') {
    return (
      <div
        className="m-auto flex max-w-[320px] flex-col items-center gap-3 px-6 py-4 text-center"
        data-testid="orchestrator-failed-body"
      >
        <div className="text-sm" style={{ color: 'var(--status-red)' }}>
          Queen failed to start
        </div>
        <div
          className="mono w-full break-words rounded border px-2 py-1.5 text-[11px] text-ter"
          style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
          data-testid="orchestrator-failed-error"
        >
          {state.error}
        </div>
        <button
          type="button"
          onClick={onRestart}
          className="rounded px-3 py-1.5 text-xs text-white hover:opacity-90"
          style={{ background: 'var(--accent)' }}
          data-testid="orchestrator-retry"
        >
          ↻ Retry
        </button>
      </div>
    )
  }
  return (
    <div
      className="m-auto flex max-w-[320px] flex-col items-center gap-3 px-6 py-4 text-center"
      data-testid="orchestrator-idle-body"
    >
      <button
        type="button"
        onClick={onStart}
        className="rounded px-4 py-1.5 text-xs text-white hover:opacity-90"
        style={{ background: 'var(--accent)' }}
        data-testid="orchestrator-start"
      >
        ▶ Start Queen
      </button>
      <div className="text-[11px] text-ter">
        Orchestrator 未启动。点击 Start Queen 后 xterm 将在此处渲染实时 PTY 输出。
      </div>
    </div>
  )
}

export const OrchestratorPane = ({
  agentModel = 'claude',
  state,
  onStart,
  onStop,
  onRestart,
}: OrchestratorPaneProps) => (
  <div
    className="flex min-w-[480px] flex-col border-r"
    style={{ width: '40%', borderColor: 'var(--border)' }}
  >
    <div
      className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
      style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
    >
      <span className="text-lg leading-none" aria-hidden>
        👑
      </span>
      <div className="flex-1">
        <div className="font-medium text-pri">Queen</div>
        <div className="mono text-[11px] text-ter">Orchestrator · {agentModel}</div>
      </div>
      <HeaderActions state={state} onStop={onStop} onRestart={onRestart} />
      <span className="role-badge role-badge--orch">orch</span>
    </div>

    <div
      className="flex min-h-0 flex-1 flex-col p-2"
      style={{ background: 'var(--bg-1)' }}
      data-testid="orchestrator-terminal-slot"
    >
      <div
        className="flex min-h-0 flex-1 rounded border"
        style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
      >
        {state.kind === 'running' ? (
          <div
            id={`orch-pty-${state.runId}`}
            className="flex h-full w-full"
            data-pty-slot="orchestrator"
          />
        ) : (
          <PlaceholderBody state={state} onStart={onStart} onRestart={onRestart} />
        )}
      </div>
    </div>
  </div>
)
