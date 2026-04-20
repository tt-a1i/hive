import { useEffect, useState } from 'react'

import { listTerminalRuns, type TerminalRunSummary } from './api.js'
import { TerminalView } from './terminal/TerminalView.js'

const REFRESH_INTERVAL_MS = 500

type WorkspaceTerminalPanelsProps = {
  hidden?: boolean
  workspaceId: string
}

export const WorkspaceTerminalPanels = ({
  hidden = false,
  workspaceId,
}: WorkspaceTerminalPanelsProps) => {
  const [terminalRuns, setTerminalRuns] = useState<TerminalRunSummary[]>([])

  useEffect(() => {
    let cancelled = false
    const loadRuns = () => {
      void listTerminalRuns(workspaceId)
        .then((runs) => {
          if (!cancelled) setTerminalRuns(runs)
        })
        .catch(() => {
          if (!cancelled) setTerminalRuns([])
        })
    }
    loadRuns()
    const interval = window.setInterval(loadRuns, REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [workspaceId])

  return (
    <section hidden={hidden} aria-hidden={hidden || undefined}>
      {terminalRuns.map((run) => (
        <TerminalView
          key={run.run_id}
          runId={run.run_id}
          title={`${run.agent_name} (${run.status})`}
        />
      ))}
    </section>
  )
}
