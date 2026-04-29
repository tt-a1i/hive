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

const StatusPill = ({ state }: { state: OrchestratorPaneState }) => {
  if (state.kind === 'running')
    return (
      <span className="status-pill status-pill--working">
        <span className="status-dot status-dot--working" aria-hidden />
        running
      </span>
    )
  if (state.kind === 'failed')
    return (
      <span className="status-pill status-pill--stopped">
        <span className="status-dot status-dot--stopped" aria-hidden />
        failed
      </span>
    )
  return (
    <span className="status-pill status-pill--stopped">
      <span className="status-dot status-dot--stopped" aria-hidden />
      stopped
    </span>
  )
}

const confirmStop = () =>
  window.confirm(
    'Stop Queen? The orchestrator PTY will be killed and any unsaved conversation in this terminal will be lost. Worker dispatches stay in their queues.'
  )
const confirmRestart = () =>
  window.confirm(
    'Restart Queen? The current PTY will be killed and a new orchestrator will start (resuming session if supported by the CLI).'
  )

const HeaderActions = ({
  state,
  onStart,
  onStop,
  onRestart,
}: Pick<OrchestratorPaneProps, 'state' | 'onStart' | 'onStop' | 'onRestart'>) => {
  if (state.kind === 'running') {
    return (
      <div className="flex gap-1.5" data-testid="orchestrator-running-actions">
        <button
          type="button"
          onClick={() => {
            if (confirmStop()) onStop()
          }}
          className="icon-btn"
          data-testid="orchestrator-stop"
        >
          <span aria-hidden>⏹</span> Stop
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirmRestart()) onRestart()
          }}
          className="icon-btn"
          data-testid="orchestrator-restart"
        >
          <span aria-hidden>↻</span> Restart
        </button>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <button
        type="button"
        onClick={onRestart}
        className="icon-btn icon-btn--primary"
        data-testid="orchestrator-retry-header"
      >
        <span aria-hidden>↻</span> Retry
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onStart}
      className="icon-btn icon-btn--primary"
      data-testid="orchestrator-start-header"
    >
      <span aria-hidden>▶</span> Start
    </button>
  )
}

const PlaceholderBody = ({
  state,
  onStart,
  onRestart,
}: Pick<OrchestratorPaneProps, 'state' | 'onStart' | 'onRestart'>) => {
  if (state.kind === 'failed') {
    return (
      <div
        className="m-auto flex max-w-[360px] flex-col items-center gap-3 px-6 py-4 text-center"
        data-testid="orchestrator-failed-body"
      >
        <div className="text-sm" style={{ color: 'var(--status-red)' }}>
          Queen failed to start
        </div>
        <div
          className="mono w-full break-words rounded border px-2 py-1.5 text-left text-[11px] text-ter"
          style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
          data-testid="orchestrator-failed-error"
        >
          {state.error}
        </div>
        <button
          type="button"
          onClick={onRestart}
          className="icon-btn icon-btn--primary"
          data-testid="orchestrator-retry"
        >
          <span aria-hidden>↻</span> Retry
        </button>
      </div>
    )
  }
  return (
    <div
      className="m-auto flex max-w-[380px] flex-col gap-4 px-6 py-4 text-left"
      data-testid="orchestrator-idle-body"
    >
      <div className="text-center">
        <div className="text-2xl" aria-hidden>
          👑
        </div>
        <div className="mt-2 text-sm text-pri">Queen is offline</div>
        <div className="mt-1 text-[11px] text-ter">
          The orchestrator runs as a CLI agent in this PTY. Start it to begin dispatching team
          members.
        </div>
      </div>
      <button
        type="button"
        onClick={onStart}
        className="icon-btn icon-btn--primary self-center"
        data-testid="orchestrator-start"
      >
        <span aria-hidden>▶</span> Start Queen
      </button>
      <ul className="space-y-1.5 text-[11px] text-ter">
        <li>· Wait for user input or paste a goal once Queen is running</li>
        <li>
          · Run <span className="mono text-sec">team list</span> to see available team members
        </li>
        <li>
          · Use <span className="mono text-sec">team send &lt;name&gt; "..."</span> to dispatch a
          task
        </li>
      </ul>
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
      <div className="min-w-0 flex-1">
        <div className="font-medium text-pri">Queen</div>
        <div className="mono truncate text-[11px] text-ter">Orchestrator · {agentModel}</div>
      </div>
      <StatusPill state={state} />
      <HeaderActions state={state} onStart={onStart} onStop={onStop} onRestart={onRestart} />
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
