type FooterProps = {
  connected: boolean
  running: number
  runtimeAddress: string
  stopped: number
  workspaceCount: number
}

const Dot = ({ color }: { color: string }) => (
  <span
    aria-hidden
    className="inline-block h-1.5 w-1.5 rounded-full align-middle"
    style={{ background: color }}
  />
)

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
    <span
      data-testid="footer-running"
      title="PTY running (working + idle)"
      className="inline-flex items-center gap-1.5"
    >
      <Dot color="var(--status-green)" /> {running} running
    </span>
    <span aria-hidden>·</span>
    <span data-testid="footer-stopped" className="inline-flex items-center gap-1.5">
      <Dot color="var(--status-red)" /> {stopped} stopped
    </span>
    <div className="flex-1" />
    <span
      title={connected ? 'connected' : 'disconnected'}
      className="inline-flex items-center gap-1.5"
      style={{ color: connected ? 'var(--status-green)' : 'var(--status-red)' }}
      data-testid="footer-connection"
    >
      <Dot color={connected ? 'var(--status-green)' : 'var(--status-red)'} />
      {connected ? 'connected' : 'disconnected'}
    </span>
  </footer>
)
