import { useEffect, useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import type { OrchestratorStartResult, TerminalRunSummary } from './api.js'
import { findRunByAgentId } from './terminal/useTerminalRuns.js'
import { useToast } from './ui/useToast.js'
import type { WorkspaceStats } from './useWorkspaceStats.js'
import { WorkspaceSubHeader } from './WorkspaceSubHeader.js'
import { AddWorkerDialog } from './worker/AddWorkerDialog.js'
import { OrchestratorPane } from './worker/OrchestratorPane.js'
import { useOrchestratorPaneState } from './worker/useOrchestratorPaneState.js'
import { useWorkerComposer } from './worker/useWorkerComposer.js'
import { WorkerModal } from './worker/WorkerModal.js'
import { WorkersPane } from './worker/WorkersPane.js'

type WorkspaceDetailProps = {
  hivePort: string
  onCreateWorker: (
    name: string,
    role: WorkerRole,
    commandPresetId: string
  ) => Promise<{ error: string | null }>
  onDeleteWorker: (workerId: string) => Promise<void>
  onStartWorker: (workerId: string) => Promise<{ error: string | null }>
  onStopWorkerRun: (runId: string) => Promise<{ error: string | null }>
  onOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  orchestratorAutostartError: string | null
  stats: WorkspaceStats
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

export const WorkspaceDetail = ({
  hivePort,
  onCreateWorker,
  onDeleteWorker,
  onStartWorker,
  onStopWorkerRun,
  onOrchestratorResult,
  orchestratorAutostartError,
  stats,
  terminalRuns,
  workers,
  workspace,
}: WorkspaceDetailProps) => {
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [deleteWorkerError, setDeleteWorkerError] = useState<string | null>(null)
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null)
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null)
  const toast = useToast()
  // Always derive the modal's worker from the latest workers prop so the
  // 500ms poll keeps it fresh — we never freeze a stale snapshot.
  const activeWorker: TeamListItem | null =
    workers.find((worker) => worker.id === activeWorkerId) ?? null
  // If the worker disappears (delete / workspace switch), close the modal.
  useEffect(() => {
    if (activeWorkerId && !activeWorker) setActiveWorkerId(null)
  }, [activeWorkerId, activeWorker])
  const composer = useWorkerComposer({ createWorker: onCreateWorker, open: composerOpen })

  // Surface composer / delete errors as toasts instead of inline alert bands.
  useEffect(() => {
    if (composer.createWorkerError)
      toast.show({ kind: 'error', message: composer.createWorkerError })
  }, [composer.createWorkerError, toast])

  useEffect(() => {
    if (deleteWorkerError) toast.show({ kind: 'error', message: deleteWorkerError })
  }, [deleteWorkerError, toast])

  // B2: when the user switches workspace, clear local error state so we don't
  // surface a stale error from the previous workspace as a fresh toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally fires only on workspace switch
  useEffect(() => {
    setDeleteWorkerError(null)
    setStartWorkerError(null)
    setStartingWorkerId(null)
  }, [workspace?.id])
  const orchestrator = useOrchestratorPaneState({
    workspaceId: workspace?.id ?? '',
    hivePort,
    terminalRuns,
    autostartError: orchestratorAutostartError,
    onClearAutostartError: () => {
      if (workspace) onOrchestratorResult(workspace.id, { ok: true, error: null, run_id: null })
    },
    onAfterStart: (result) => {
      if (workspace) onOrchestratorResult(workspace.id, result)
    },
  })

  if (!workspace) return null

  const activeWorkerRun = activeWorker ? findRunByAgentId(terminalRuns, activeWorker.id) : undefined

  const handleDeleteWorker = (worker: TeamListItem) => {
    setDeleteWorkerError(null)
    void onDeleteWorker(worker.id)
      .then(() => setActiveWorkerId(null))
      .catch((error) => {
        setDeleteWorkerError(error instanceof Error ? error.message : String(error))
      })
  }

  const handleStartWorker = (worker: TeamListItem) => {
    setStartWorkerError(null)
    setStartingWorkerId(worker.id)
    void onStartWorker(worker.id)
      .then(({ error }) => {
        if (error) setStartWorkerError(error)
      })
      .catch((error) => {
        setStartWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStartingWorkerId(null))
  }

  const handleRestartWorker = async (worker: TeamListItem, runId: string) => {
    const stopResult = await onStopWorkerRun(runId)
    if (stopResult.error) return stopResult
    return onStartWorker(worker.id)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkspaceSubHeader stats={stats} workspace={workspace} />

      <div className="flex min-h-0 flex-1">
        <OrchestratorPane
          state={orchestrator.state}
          onStart={orchestrator.start}
          onStop={orchestrator.stop}
          onRestart={orchestrator.restart}
        />
        <WorkersPane
          onAddWorkerClick={() => setComposerOpen(true)}
          onOpenWorker={(worker) => setActiveWorkerId(worker.id)}
          workers={workers}
        />
      </div>
      {activeWorker ? (
        <WorkerModal
          onClose={() => setActiveWorkerId(null)}
          onDelete={handleDeleteWorker}
          onRestart={handleRestartWorker}
          onStart={handleStartWorker}
          onStop={onStopWorkerRun}
          runId={activeWorkerRun?.run_id ?? null}
          startError={startWorkerError}
          starting={startingWorkerId === activeWorker.id}
          worker={activeWorker}
        />
      ) : null}

      {composerOpen ? (
        <AddWorkerDialog
          commandPresets={composer.commandPresets}
          commandPresetId={composer.commandPresetId}
          creating={composer.creating}
          onClose={() => setComposerOpen(false)}
          onNameChange={composer.setWorkerName}
          onPresetChange={composer.setCommandPresetId}
          onRoleChange={composer.setWorkerRole}
          onSubmit={(event) => composer.submit(event, () => setComposerOpen(false))}
          workerName={composer.workerName}
          workerRole={composer.workerRole}
        />
      ) : null}
    </div>
  )
}
