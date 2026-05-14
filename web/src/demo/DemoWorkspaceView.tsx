import { WorkersPane } from '../worker/WorkersPane.js'
import { DemoBanner } from './DemoBanner.js'
import { DEMO_TERMINAL_SCROLLBACK, DEMO_WORKERS } from './demo-fixture.js'

type DemoWorkspaceViewProps = {
  onExit: () => void
}

/**
 * Renders a static demo workspace layout without any server-calling hooks.
 *
 * Design decision: TerminalView is tightly coupled to WebSocket subscriptions
 * and portal-based PTY mounting. Rather than extending that surface with
 * readOnly/initialScrollback, demo scrollback is rendered as a <pre> block
 * inside each worker's scrollback slot. This keeps the demo path self-contained
 * and avoids xterm.js setup in a read-only context.
 */
export const DemoWorkspaceView = ({ onExit }: DemoWorkspaceViewProps) => (
  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <DemoBanner onExit={onExit} />
    <div className="flex min-h-0 flex-1">
      {/* Demo orchestrator panel — shows orch scrollback as pre-recorded text */}
      <div
        className="flex min-w-[320px] shrink-0 flex-col border-r"
        style={{ width: '40%', borderColor: 'var(--border)', background: 'var(--bg-crust)' }}
        data-testid="orchestrator-pane-shell"
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-3 py-2 text-xs text-ter"
          style={{ borderColor: 'var(--border)' }}
        >
          <span>Orchestrator — pre-recorded</span>
          <span
            data-testid="terminal-readonly-badge"
            className="rounded bg-2 px-1.5 py-0.5 text-xs text-ter"
          >
            DEMO read-only
          </span>
        </div>
        <pre
          className="mono flex-1 overflow-auto p-3 text-xs leading-relaxed text-sec"
          data-testid="demo-scrollback-demo-orch"
          style={{ background: 'var(--bg-crust)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        >
          {DEMO_TERMINAL_SCROLLBACK['demo-orch']}
        </pre>
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
