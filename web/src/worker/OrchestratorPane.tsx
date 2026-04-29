import { Crown, Play, RotateCcw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'

export type OrchestratorPaneState =
  | { kind: 'idle' }
  | { kind: 'running'; runId: string }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  state: OrchestratorPaneState
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}

const RunningOverlay = ({
  onAskStop,
  onAskRestart,
}: {
  onAskStop: () => void
  onAskRestart: () => void
}) => (
  <div
    className="pointer-events-none absolute top-2 left-2 z-10 flex items-center gap-1.5"
    data-testid="orchestrator-running-actions"
  >
    {/* Status chip — persistent so the user always knows this PTY is Queen. */}
    <span
      className="status-pill status-pill--working pointer-events-auto"
      data-testid="orch-status-running"
      title="Orchestrator running"
    >
      <Crown size={10} aria-hidden />
      <span>Queen</span>
    </span>
    <button
      type="button"
      onClick={onAskStop}
      className="icon-btn pointer-events-auto"
      data-testid="orchestrator-stop"
      title="Stop Queen"
    >
      <Square size={11} aria-hidden /> Stop
    </button>
    <button
      type="button"
      onClick={onAskRestart}
      className="icon-btn pointer-events-auto"
      data-testid="orchestrator-restart"
      title="Restart Queen"
    >
      <RotateCcw size={11} aria-hidden /> Restart
    </button>
  </div>
)

const IdleBody = ({ onStart }: { onStart: () => void }) => (
  <div data-testid="orchestrator-idle-body" className="flex flex-1">
    <EmptyState
      icon={<Crown size={32} />}
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

const FailedBody = ({ error, onRestart }: { error: string; onRestart: () => void }) => (
  <div data-testid="orchestrator-failed-body" className="flex flex-1">
    <EmptyState
      icon={<Crown size={32} />}
      title="Queen failed to start"
      description={error}
      action={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRestart}
            className="icon-btn icon-btn--primary"
            data-testid="orchestrator-retry"
          >
            <RotateCcw size={12} aria-hidden /> Retry
          </button>
          {/* Header retry was a duplicate; with the header removed, the body
              CTA is the canonical retry. We keep `orchestrator-retry-header`
              as an alias for back-compat with existing tests. */}
          <span data-testid="orchestrator-retry-header" className="sr-only">
            Retry
          </span>
        </div>
      }
    />
  </div>
)

export const OrchestratorPane = ({ state, onStart, onStop, onRestart }: OrchestratorPaneProps) => {
  const [confirmKind, setConfirmKind] = useState<'stop' | 'restart' | null>(null)

  useEffect(() => {
    if (state.kind !== 'running' && confirmKind !== null) {
      setConfirmKind(null)
    }
  }, [state.kind, confirmKind])

  const closeConfirm = () => setConfirmKind(null)
  const onConfirmAction = () => {
    if (confirmKind === 'stop') onStop()
    if (confirmKind === 'restart') onRestart()
  }

  return (
    <div
      className="relative flex min-w-[480px] flex-col border-r"
      style={{ width: '40%', borderColor: 'var(--border)' }}
    >
      <div
        className="flex min-h-0 flex-1 flex-col p-2"
        style={{ background: 'var(--bg-1)' }}
        data-testid="orchestrator-terminal-slot"
      >
        <div
          className="relative flex min-h-0 flex-1 rounded-lg border"
          style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
        >
          {state.kind === 'running' ? (
            <>
              <RunningOverlay
                onAskStop={() => setConfirmKind('stop')}
                onAskRestart={() => setConfirmKind('restart')}
              />
              <div
                id={`orch-pty-${state.runId}`}
                className="flex h-full w-full"
                data-pty-slot="orchestrator"
              />
            </>
          ) : state.kind === 'failed' ? (
            <FailedBody error={state.error} onRestart={onRestart} />
          ) : (
            <IdleBody onStart={onStart} />
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
