import { useEffect, useState } from 'react'

import { listTerminalRuns, type TerminalRunSummary } from './api.js'
import { TerminalView } from './terminal/TerminalView.js'

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
    void listTerminalRuns(workspaceId)
      .then((runs) => {
        if (!cancelled) setTerminalRuns(runs)
      })
      .catch(() => {
        if (!cancelled) setTerminalRuns([])
      })
    return () => {
      cancelled = true
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
