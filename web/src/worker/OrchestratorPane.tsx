type OrchestratorPaneProps = {
  agentModel?: string
  runId: string | null
}

export const OrchestratorPane = ({ agentModel = 'claude', runId }: OrchestratorPaneProps) => (
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
        {runId ? (
          <div
            id={`orch-pty-${runId}`}
            className="flex h-full w-full"
            data-pty-slot="orchestrator"
          />
        ) : (
          <div className="m-auto text-xs text-ter">
            Orchestrator 未启动。启动 Queen 后 xterm 将在此处渲染实时 PTY 输出。
          </div>
        )}
      </div>
    </div>
  </div>
)
