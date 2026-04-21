import type { FormEvent } from 'react'
import { useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import {
  findOrchestratorRun,
  findRunByAgentId,
  useTerminalRuns,
} from './terminal/useTerminalRuns.js'
import { WorkspaceSubHeader } from './WorkspaceSubHeader.js'
import { AddWorkerDialog } from './worker/AddWorkerDialog.js'
import { OrchestratorPane } from './worker/OrchestratorPane.js'
import { WorkerModal } from './worker/WorkerModal.js'
import { WorkersPane } from './worker/WorkersPane.js'

type WorkspaceDetailProps = {
  onCreateWorker: (name: string, role: WorkerRole) => void
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

export const WorkspaceDetail = ({ onCreateWorker, workers, workspace }: WorkspaceDetailProps) => {
  const [workerName, setWorkerName] = useState('')
  const [workerRole, setWorkerRole] = useState<WorkerRole>('coder')
  const [activeWorker, setActiveWorker] = useState<TeamListItem | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const terminalRuns = useTerminalRuns(workspace?.id ?? null)

  if (!workspace) return null

  const activeCount = workers.filter((worker) => worker.status === 'working').length
  const orchestratorRun = findOrchestratorRun(terminalRuns, workspace.id)
  const activeWorkerRun = activeWorker ? findRunByAgentId(terminalRuns, activeWorker.id) : undefined

  const handleAddWorkerSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onCreateWorker(workerName, workerRole)
    setWorkerName('')
    setWorkerRole('coder')
    setComposerOpen(false)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkspaceSubHeader
        activeCount={activeCount}
        agentCount={workers.length + 1}
        workspace={workspace}
      />

      <div className="flex min-h-0 flex-1">
        <OrchestratorPane runId={orchestratorRun?.run_id ?? null} />
        <WorkersPane
          onAddWorkerClick={() => setComposerOpen(true)}
          onOpenWorker={setActiveWorker}
          workers={workers}
        />
      </div>

      {activeWorker ? (
        <WorkerModal
          onClose={() => setActiveWorker(null)}
          runId={activeWorkerRun?.run_id ?? null}
          worker={activeWorker}
        />
      ) : null}

      {composerOpen ? (
        <AddWorkerDialog
          onClose={() => setComposerOpen(false)}
          onNameChange={setWorkerName}
          onRoleChange={setWorkerRole}
          onSubmit={handleAddWorkerSubmit}
          workerName={workerName}
          workerRole={workerRole}
        />
      ) : null}
    </div>
  )
}
