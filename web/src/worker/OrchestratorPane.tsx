import { Crown, LoaderCircle, RotateCcw } from 'lucide-react'

import { EmptyState } from '../ui/EmptyState.js'
import { OrchestratorHintOverlay } from './OrchestratorHintOverlay.js'

export type OrchestratorPaneState =
  | { kind: 'starting' }
  | { kind: 'running'; runId: string }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  state: OrchestratorPaneState
  /** Kept for API stability; M6-B will surface stop via the ⌘K palette. */
  onStop: () => void
  onRestart: () => void
  /** True once the user has typed anything into the orchestrator terminal. */
  hasUserInput?: boolean
  /** Flip hasUserInput to true (idempotent). */
  markUserInput?: () => void
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

export const OrchestratorPane = ({
  state,
  onRestart,
  hasUserInput = false,
  markUserInput,
}: OrchestratorPaneProps) => (
  <div
    className="relative flex h-full w-full min-w-0 flex-col"
    style={{ background: 'var(--bg-crust)' }}
    data-testid="orchestrator-terminal-slot"
  >
    {state.kind === 'running' ? (
      // biome-ignore lint/a11y/noStaticElementInteractions: outer div captures keydown bubbling from the xterm hidden textarea so the hint overlay auto-dismisses on first keystroke without touching TerminalView's API
      <div className="relative flex h-full w-full" onKeyDown={markUserInput}>
        <div
          id={`orch-pty-${state.runId}`}
          className="flex h-full w-full"
          data-pty-slot="orchestrator"
        />
        <OrchestratorHintOverlay visible={!hasUserInput} onDismiss={markUserInput ?? (() => {})} />
      </div>
    ) : state.kind === 'failed' ? (
      <FailedBody error={state.error} onRestart={onRestart} />
    ) : (
      <StartingBody />
    )}
  </div>
)
