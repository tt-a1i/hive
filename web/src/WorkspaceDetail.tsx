import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { type CommandPreset, listCommandPresets, type OrchestratorStartResult } from './api.js'
import { findRunByAgentId, useTerminalRuns } from './terminal/useTerminalRuns.js'
import { WorkspaceSubHeader } from './WorkspaceSubHeader.js'
import { AddWorkerDialog } from './worker/AddWorkerDialog.js'
import { OrchestratorPane } from './worker/OrchestratorPane.js'
import { useOrchestratorPaneState } from './worker/useOrchestratorPaneState.js'
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
  onOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  orchestratorAutostartError: string | null
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

export const WorkspaceDetail = ({
  hivePort,
  onCreateWorker,
  onDeleteWorker,
  onStartWorker,
  onOrchestratorResult,
  orchestratorAutostartError,
  workers,
  workspace,
}: WorkspaceDetailProps) => {
  const [workerName, setWorkerName] = useState('')
  const [workerRole, setWorkerRole] = useState<WorkerRole>('coder')
  const [commandPresets, setCommandPresets] = useState<CommandPreset[]>([])
  const [commandPresetId, setCommandPresetId] = useState('claude')
  const [createWorkerError, setCreateWorkerError] = useState<string | null>(null)
  const [deleteWorkerError, setDeleteWorkerError] = useState<string | null>(null)
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null)
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null)
  const [creatingWorker, setCreatingWorker] = useState(false)
  const [activeWorker, setActiveWorker] = useState<TeamListItem | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const terminalRuns = useTerminalRuns(workspace?.id ?? null)
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

  useEffect(() => {
    if (!composerOpen) return
    let cancelled = false
    void listCommandPresets()
      .then((presets) => {
        if (cancelled) return
        setCommandPresets(presets)
        setCommandPresetId((current) => {
          if (presets.some((preset) => preset.id === current)) return current
          return presets.find((preset) => preset.id === 'claude')?.id ?? presets[0]?.id ?? ''
        })
      })
      .catch((error) => {
        if (!cancelled) {
          setCreateWorkerError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [composerOpen])

  if (!workspace) return null

  const runningCount = terminalRuns.length
  const activeWorkerRun = activeWorker ? findRunByAgentId(terminalRuns, activeWorker.id) : undefined

  const handleAddWorkerSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreatingWorker(true)
    setCreateWorkerError(null)
    void onCreateWorker(workerName, workerRole, commandPresetId)
      .then(({ error }) => {
        setWorkerName('')
        setWorkerRole('coder')
        setCommandPresetId('claude')
        setComposerOpen(false)
        if (error) setCreateWorkerError(error)
      })
      .catch((error) => {
        setCreateWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setCreatingWorker(false))
  }

  const handleDeleteWorker = (worker: TeamListItem) => {
    const confirmed = window.confirm(`Delete worker "${worker.name}"?`)
    if (!confirmed) return
    setDeleteWorkerError(null)
    void onDeleteWorker(worker.id)
      .then(() => setActiveWorker(null))
      .catch((error) => {
        setDeleteWorkerError(error instanceof Error ? error.message : String(error))
      })
  }

  const handleStartWorker = (worker: TeamListItem) => {
    setStartWorkerError(null)
    setStartingWorkerId(worker.id)
    void onStartWorker(worker.id)
      .then(({ error }) => {
        if (error) {
          setStartWorkerError(error)
          return
        }
        setActiveWorker((current) =>
          current?.id === worker.id ? { ...current, status: 'idle' } : current
        )
      })
      .catch((error) => {
        setStartWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStartingWorkerId(null))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkspaceSubHeader
        runningCount={runningCount}
        agentCount={workers.length + 1}
        workspace={workspace}
      />

      <div className="flex min-h-0 flex-1">
        <OrchestratorPane
          state={orchestrator.state}
          onStart={orchestrator.start}
          onStop={orchestrator.stop}
          onRestart={orchestrator.restart}
        />
        <WorkersPane
          onAddWorkerClick={() => setComposerOpen(true)}
          onOpenWorker={setActiveWorker}
          workers={workers}
        />
      </div>
      {createWorkerError ? (
        <p
          role="alert"
          className="border-t border-status-red/30 bg-status-red/10 px-4 py-2 text-xs text-status-red"
        >
          {createWorkerError}
        </p>
      ) : null}
      {deleteWorkerError ? (
        <p
          role="alert"
          className="border-t border-status-red/30 bg-status-red/10 px-4 py-2 text-xs text-status-red"
        >
          {deleteWorkerError}
        </p>
      ) : null}

      {activeWorker ? (
        <WorkerModal
          onClose={() => setActiveWorker(null)}
          onDelete={handleDeleteWorker}
          onStart={handleStartWorker}
          runId={activeWorkerRun?.run_id ?? null}
          startError={startWorkerError}
          starting={startingWorkerId === activeWorker.id}
          worker={activeWorker}
        />
      ) : null}

      {composerOpen ? (
        <AddWorkerDialog
          commandPresets={commandPresets}
          commandPresetId={commandPresetId}
          creating={creatingWorker}
          onClose={() => setComposerOpen(false)}
          onNameChange={setWorkerName}
          onPresetChange={setCommandPresetId}
          onRoleChange={setWorkerRole}
          onSubmit={handleAddWorkerSubmit}
          workerName={workerName}
          workerRole={workerRole}
        />
      ) : null}
    </div>
  )
}
