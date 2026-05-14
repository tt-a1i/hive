import { Crown, LoaderCircle, Play, RotateCcw } from 'lucide-react'

import { EmptyState } from '../ui/EmptyState.js'

export type OrchestratorPaneState =
  | { kind: 'starting' }
  | { kind: 'running'; runId: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  state: OrchestratorPaneState
  /** Kept for API stability; M6-B will surface stop via the ⌘K palette. */
  onStop: () => void
  onStart: () => void
  onRestart: () => void
}

const StartingBody = () => (
  <div data-testid="orchestrator-starting-body" className="flex flex-1">
    <EmptyState
      icon={<LoaderCircle size={26} className="animate-spin" />}
      title="Starting Queen"
      description="Preparing the orchestrator terminal."
    />
  </div>
)

const StoppedBody = ({ onStart }: { onStart: () => void }) => (
  <div data-testid="orchestrator-stopped-body" className="flex flex-1">
    <EmptyState
      icon={<Crown size={26} />}
      title="Queen is stopped"
      description="Start the orchestrator when you are ready to dispatch work."
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

export const OrchestratorPane = ({ state, onRestart, onStart }: OrchestratorPaneProps) => (
  <div
    className="relative flex h-full w-full min-w-0 flex-col"
    style={{ background: 'var(--bg-crust)' }}
    data-testid="orchestrator-terminal-slot"
  >
    {state.kind === 'running' ? (
      <div
        id={`orch-pty-${state.runId}`}
        className="flex h-full w-full"
        data-pty-slot="orchestrator"
      />
    ) : state.kind === 'failed' ? (
      <FailedBody error={state.error} onRestart={onRestart} />
    ) : state.kind === 'stopped' ? (
      <StoppedBody onStart={onStart} />
    ) : (
      <StartingBody />
    )}
  </div>
)
