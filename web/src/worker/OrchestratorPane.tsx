import { Crown, Play, RotateCcw, Square } from 'lucide-react'
import { useState } from 'react'

import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'

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
      <span className="status-pill status-pill--working" data-testid="orch-status-running">
        <span className="status-dot status-dot--working" aria-hidden />
        running
      </span>
    )
  if (state.kind === 'failed')
    return (
      <span className="status-pill status-pill--stopped" data-testid="orch-status-failed">
        <span className="status-dot status-dot--stopped" aria-hidden />
        failed
      </span>
    )
  return (
    <span className="status-pill status-pill--stopped" data-testid="orch-status-stopped">
      <span className="status-dot status-dot--stopped" aria-hidden />
      stopped
    </span>
  )
}

const HeaderActions = ({
  state,
  onStart,
  onRestart,
  onAskStop,
  onAskRestart,
}: {
  state: OrchestratorPaneState
  onStart: () => void
  onRestart: () => void
  onAskStop: () => void
  onAskRestart: () => void
}) => {
  if (state.kind === 'running') {
    return (
      <div className="flex gap-1.5" data-testid="orchestrator-running-actions">
        <button
          type="button"
          onClick={onAskStop}
          className="icon-btn"
          data-testid="orchestrator-stop"
        >
          <Square size={12} aria-hidden /> Stop
        </button>
        <button
          type="button"
          onClick={onAskRestart}
          className="icon-btn"
          data-testid="orchestrator-restart"
        >
          <RotateCcw size={12} aria-hidden /> Restart
        </button>
      </div>
    )
  }
  if (state.kind === 'failed') {
    // Failed = PTY already exited. No live process to kill, so retry is direct
    // (no Confirm dialog, matches pre-M6 behavior).
    return (
      <button
        type="button"
        onClick={onRestart}
        className="icon-btn icon-btn--primary"
        data-testid="orchestrator-retry-header"
      >
        <RotateCcw size={12} aria-hidden /> Retry
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
      <Play size={12} aria-hidden /> Start
    </button>
  )
}

const PlaceholderBody = ({
  state,
  onStart,
  onRestart,
}: {
  state: OrchestratorPaneState
  onStart: () => void
  onRestart: () => void
}) => {
  if (state.kind === 'failed') {
    return (
      <div data-testid="orchestrator-failed-body" className="flex flex-1">
        <EmptyState
          icon={<Crown size={28} />}
          title="Queen failed to start"
          description={state.error}
          action={
            <button
              type="button"
              onClick={onRestart}
              className="icon-btn icon-btn--primary"
              data-testid="orchestrator-retry"
            >
              <RotateCcw size={12} aria-hidden /> Retry
            </button>
          }
        />
      </div>
    )
  }
  return (
    <div data-testid="orchestrator-idle-body" className="flex flex-1">
      <EmptyState
        icon={<Crown size={28} />}
        title="Queen is offline"
        description="Start the orchestrator PTY to begin dispatching team members."
        action={
          <button
            type="button"
            onClick={onStart}
            className="icon-btn icon-btn--primary"
            data-testid="orchestrator-start"
          >
            <Play size={12} aria-hidden /> Start Queen
          </button>
        }
      />
    </div>
  )
}

export const OrchestratorPane = ({
  agentModel = 'claude',
  state,
  onStart,
  onStop,
  onRestart,
}: OrchestratorPaneProps) => {
  const [confirmKind, setConfirmKind] = useState<'stop' | 'restart' | null>(null)

  const closeConfirm = () => setConfirmKind(null)
  const onConfirmAction = () => {
    if (confirmKind === 'stop') onStop()
    if (confirmKind === 'restart') onRestart()
  }

  return (
    <div
      className="flex min-w-[480px] flex-col border-r"
      style={{ width: '40%', borderColor: 'var(--border)' }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
        style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
      >
        <Crown size={16} aria-hidden className="text-pri" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-pri">Queen</div>
          <div className="mono truncate text-[11px] text-ter">Orchestrator · {agentModel}</div>
        </div>
        <StatusPill state={state} />
        <HeaderActions
          state={state}
          onStart={onStart}
          onRestart={onRestart}
          onAskStop={() => setConfirmKind('stop')}
          onAskRestart={() => setConfirmKind('restart')}
        />
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

      <Confirm
        open={confirmKind === 'stop'}
        onOpenChange={(open) => !open && closeConfirm()}
        title="Stop Queen?"
        description="The orchestrator PTY will be killed. Worker dispatches stay in their queues."
        confirmLabel="Stop"
        confirmKind="danger"
        onConfirm={onConfirmAction}
      />
      <Confirm
        open={confirmKind === 'restart'}
        onOpenChange={(open) => !open && closeConfirm()}
        title="Restart Queen?"
        description="The current PTY will be killed and a new orchestrator will start (resuming session if supported)."
        confirmLabel="Restart"
        onConfirm={onConfirmAction}
      />
    </div>
  )
}
