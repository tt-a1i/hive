type FooterProps = {
  connected: boolean
  running: number
  runtimeAddress: string
  stopped: number
  workspaceCount: number
}

export const Footer = ({
  connected,
  running,
  runtimeAddress,
  stopped,
  workspaceCount,
}: FooterProps) => (
  <footer
    className="mono flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[10px] text-ter"
    style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
  >
    <span>Hive runtime · {runtimeAddress}</span>
    <span aria-hidden>·</span>
    <span>
      {workspaceCount} workspace{workspaceCount === 1 ? '' : 's'}
    </span>
    <span aria-hidden>·</span>
    <span data-testid="footer-running" title="PTY running (working + idle)">
      <span style={{ color: 'var(--status-green)' }}>●</span> {running} running
    </span>
    <span aria-hidden>·</span>
    <span data-testid="footer-stopped">
      <span style={{ color: 'var(--status-red)' }}>○</span> {stopped} stopped
    </span>
    <div className="flex-1" />
    <span
      title={connected ? 'connected' : 'disconnected'}
      style={{ color: connected ? 'var(--status-green)' : 'var(--status-red)' }}
    >
      {connected ? '● connected' : '● disconnected'}
    </span>
  </footer>
)
