import { useEffect, useState } from 'react'

import { listTerminalRuns, type TerminalRunSummary } from './api.js'
import { TerminalView } from './terminal/TerminalView.js'
import { mergeTerminalRuns } from './terminal/useOptimisticTerminalRuns.js'

const REFRESH_INTERVAL_MS = 500

type WorkspaceTerminalPanelsProps = {
  hidden?: boolean
  optimisticRuns?: TerminalRunSummary[]
  workspaceId: string
}

export const WorkspaceTerminalPanels = ({
  hidden = false,
  optimisticRuns = [],
  workspaceId,
}: WorkspaceTerminalPanelsProps) => {
  const [terminalRuns, setTerminalRuns] = useState<TerminalRunSummary[]>([])
  const mergedRuns = mergeTerminalRuns(terminalRuns, optimisticRuns)

  useEffect(() => {
    let cancelled = false
    const loadRuns = () => {
      void listTerminalRuns(workspaceId)
        .then((runs) => {
          if (!cancelled) setTerminalRuns(runs)
        })
        .catch((error: unknown) => {
          if (!cancelled) setTerminalRuns([])
          console.error('[hive] swallowed:terminalPanels.listRuns', error)
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
    <section hidden={hidden} aria-hidden={hidden || undefined} aria-label="Terminal panels">
      {mergedRuns.map((run) => (
        <TerminalView
          key={run.run_id}
          runId={run.run_id}
          title={`${run.agent_name} (${run.status})`}
        />
      ))}
    </section>
  )
}
