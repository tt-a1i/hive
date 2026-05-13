import { DEMO_WORKERS } from './demo-fixture.js'
import { DemoBanner } from './DemoBanner.js'
import { WorkersPane } from '../worker/WorkersPane.js'

type DemoWorkspaceViewProps = {
  onExit: () => void
}

/**
 * Renders a static demo workspace layout — DemoBanner + WorkersPane with pre-baked
 * demo workers. No server hooks are invoked; demo never touches the backend.
 */
export const DemoWorkspaceView = ({ onExit }: DemoWorkspaceViewProps) => (
  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <DemoBanner onExit={onExit} />
    <div className="flex min-h-0 flex-1">
      {/* Placeholder orchestrator column — demo has no live orch PTY */}
      <div
        className="flex min-w-[320px] shrink-0 flex-col items-center justify-center border-r"
        style={{ width: '40%', borderColor: 'var(--border)', background: 'var(--bg-crust)' }}
        data-testid="orchestrator-pane-shell"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="text-sm font-medium text-pri">Orchestrator (demo)</span>
          <span className="text-xs text-ter">Pre-recorded — not running</span>
        </div>
      </div>
      <WorkersPane
        onAddWorkerClick={() => {}}
        onDeleteWorker={() => {}}
        onOpenWorker={() => {}}
        onRenameWorker={() => Promise.resolve({ error: null })}
        onStartWorker={() => {}}
        startingWorkerId={null}
        terminalRuns={[]}
        workers={DEMO_WORKERS}
      />
    </div>
  </div>
)
