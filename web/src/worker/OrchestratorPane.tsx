import { Crown, Play, RotateCcw } from 'lucide-react'

import { EmptyState } from '../ui/EmptyState.js'

export type OrchestratorPaneState =
  | { kind: 'idle' }
  | { kind: 'running'; runId: string }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  state: OrchestratorPaneState
  onStart: () => void
  /** Kept for API stability; M6-B will surface stop via the ⌘K palette. */
  onStop: () => void
  onRestart: () => void
}

const IdleBody = ({ onStart }: { onStart: () => void }) => (
  <div data-testid="orchestrator-idle-body" className="flex flex-1">
    <EmptyState
      icon={<Crown size={26} />}
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
      icon={<Crown size={26} />}
      title="Queen failed to start"
      description={error}
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
    {/* Header retry was a duplicate; alias kept for back-compat. */}
    <span data-testid="orchestrator-retry-header" className="sr-only">
      Retry
    </span>
  </div>
)

export const OrchestratorPane = ({ state, onStart, onRestart }: OrchestratorPaneProps) => (
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
          <div
            id={`orch-pty-${state.runId}`}
            className="flex h-full w-full"
            data-pty-slot="orchestrator"
          />
        ) : state.kind === 'failed' ? (
          <FailedBody error={state.error} onRestart={onRestart} />
        ) : (
          <IdleBody onStart={onStart} />
        )}
      </div>
    </div>
  </div>
)
