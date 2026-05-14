import { useEffect, useState } from 'react'

import type { TeamListItem, WorkerRole, WorkspaceSummary } from '../../src/shared/types.js'
import { type OrchestratorStartResult, renameWorker, type TerminalRunSummary } from './api.js'
import { WorkspaceNotifications } from './notifications/WorkspaceNotifications.js'
import { findRunByAgentId } from './terminal/useTerminalRuns.js'
import { useToast } from './ui/useToast.js'
import { usePaneSplit } from './usePaneSplit.js'
import type { WorkspaceStats } from './useWorkspaceStats.js'
import { AddWorkerDialog } from './worker/AddWorkerDialog.js'
import { OrchestratorPane } from './worker/OrchestratorPane.js'
import { useOrchestratorPaneState } from './worker/useOrchestratorPaneState.js'
import { useWorkerComposer } from './worker/useWorkerComposer.js'
import { WelcomePane } from './worker/WelcomePane.js'
import { WorkerModal } from './worker/WorkerModal.js'
import { WorkersPane } from './worker/WorkersPane.js'

type WorkspaceDetailProps = {
  onCreateWorker: (
    name: string,
    role: WorkerRole,
    commandPresetId: string,
    roleDescription: string
  ) => Promise<{ error: string | null; runId: string | null }>
  onDeleteWorker: (workerId: string) => Promise<void>
  onStartWorker: (workerId: string) => Promise<{ error: string | null; runId: string | null }>
  onOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  onRequestAddWorkspace: () => void
  onTryDemo?: () => void
  welcomeDisabledReason?: string
  orchestratorAutostartError: string | null
  orchestratorAutostartRunId: string | null
  /** Kept for API stability — sub-header consumed it; M6-A removed the bar but the prop signature stays so caller wiring is untouched. */
  stats?: WorkspaceStats
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

export const WorkspaceDetail = ({
  onCreateWorker,
  onDeleteWorker,
  onStartWorker,
  onOrchestratorResult,
  onRequestAddWorkspace,
  onTryDemo,
  welcomeDisabledReason,
  orchestratorAutostartError,
  orchestratorAutostartRunId,
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
    terminalRuns,
    autostartError: orchestratorAutostartError,
    suppressAutostartRunId: orchestratorAutostartRunId,
    onClearAutostartError: () => {
      if (workspace) onOrchestratorResult(workspace.id, { ok: true, error: null, run_id: null })
    },
    onAfterStart: (result) => {
      if (workspace) onOrchestratorResult(workspace.id, result)
    },
  })
  const split = usePaneSplit()

  if (!workspace) {
    const welcomeProps: {
      onAddWorkspace: () => void
      onTryDemo?: () => void
      disabledReason?: string
    } = { onAddWorkspace: onRequestAddWorkspace }
    if (onTryDemo) welcomeProps.onTryDemo = onTryDemo
    if (welcomeDisabledReason) welcomeProps.disabledReason = welcomeDisabledReason
    return <WelcomePane {...welcomeProps} />
  }

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

  const handleRenameWorker = async (
    worker: TeamListItem,
    newName: string
  ): Promise<{ error: string | null }> => {
    try {
      await renameWorker(workspace.id, worker.id, newName)
      toast.show({
        kind: 'success',
        message: `Renamed to "${newName}".`,
      })
      return { error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message: `Rename failed: ${message}` })
      return { error: message }
    }
  }

  const orchWidth = `${(split.orchPct * 100).toFixed(2)}%`

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-2)' }}>
      <WorkspaceNotifications terminalRuns={terminalRuns} workers={workers} workspace={workspace} />
      <div ref={split.containerRef} className="relative flex min-h-0 flex-1">
        <div
          className="flex min-w-[480px] shrink-0 flex-col"
          style={{ width: orchWidth }}
          data-testid="orchestrator-pane-shell"
        >
          <OrchestratorPane
            state={orchestrator.state}
            onStop={orchestrator.stop}
            onStart={orchestrator.start}
            onRestart={orchestrator.restart}
          />
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: <hr> can't host pointer/keyboard handlers and the visible accent line; aria role="separator" is the canonical resize-handle role */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Orchestrator and Team Members panes"
          aria-valuenow={Math.round(split.orchPct * 100)}
          aria-valuemin={30}
          aria-valuemax={78}
          tabIndex={0}
          className="pane-splitter"
          style={{ left: `calc(${orchWidth} - 4px)` }}
          data-dragging={split.dragging || undefined}
          data-testid="pane-splitter"
          onPointerDown={split.beginDrag}
          onKeyDown={split.onKeyDown}
        />
        <WorkersPane
          onAddWorkerClick={() => setComposerOpen(true)}
          onDeleteWorker={handleDeleteWorker}
          onOpenWorker={(worker) => setActiveWorkerId(worker.id)}
          onRenameWorker={handleRenameWorker}
          onStartWorker={handleStartWorker}
          startingWorkerId={startingWorkerId}
          terminalRuns={terminalRuns}
          workers={workers}
        />
      </div>
      {activeWorker ? (
        <WorkerModal
          onClose={() => setActiveWorkerId(null)}
          onStart={handleStartWorker}
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
          onRandomName={composer.randomizeWorkerName}
          onRoleDescriptionChange={composer.setRoleDescription}
          onRoleDescriptionReset={composer.resetRoleDescription}
          onRoleChange={composer.setWorkerRole}
          onSubmit={(event) => composer.submit(event, () => setComposerOpen(false))}
          roleDescription={composer.roleDescription}
          roleDescriptionDefault={composer.roleDescriptionDefault}
          workerName={composer.workerName}
          workerRole={composer.workerRole}
        />
      ) : null}
    </div>
  )
}
