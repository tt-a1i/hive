import '@xterm/xterm/css/xterm.css'

import { useTerminalRun } from './useTerminalRun.js'

interface TerminalViewProps {
  runId: string
  title: string
}

export const TerminalView = ({ runId, title }: TerminalViewProps) => {
  const { containerRef, error, status } = useTerminalRun(runId)

  return (
    <section aria-label={`Terminal ${title}`}>
      <h4>{title}</h4>
      <p>{status}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div data-testid={`terminal-${runId}`} ref={containerRef} />
    </section>
  )
}
