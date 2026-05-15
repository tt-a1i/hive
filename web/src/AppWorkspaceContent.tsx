import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import type { OrchestratorStartResult, TerminalRunSummary } from './api.js'
import { DemoWorkspaceView } from './demo/DemoWorkspaceView.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'
import type { WorkerActions } from './worker/useWorkerActions.js'

type AppWorkspaceContentProps = {
  activeId: string | undefined
  activeWorkspace: WorkspaceSummary | undefined
  bootstrapError: string | null
  demoMode: boolean
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onExitDemo: () => void
  onRequestAddWorkspace: () => void
  onTryDemo: () => void
  optimisticRunsByWorkspaceId: Record<string, TerminalRunSummary[]>
  orchestratorAutostartErrors: Record<string, string | null>
  orchestratorAutostartRunIds: Record<string, string | null>
  recordOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  terminalRuns: TerminalRunSummary[]
  workerActions: WorkerActions
  workers: TeamListItem[]
}

export const AppWorkspaceContent = ({
  activeId,
  activeWorkspace,
  bootstrapError,
  demoMode,
  onDeleteWorkspace,
  onExitDemo,
  onRequestAddWorkspace,
  onTryDemo,
  optimisticRunsByWorkspaceId,
  orchestratorAutostartErrors,
  orchestratorAutostartRunIds,
  recordOrchestratorResult,
  terminalRuns,
  workerActions,
  workers,
}: AppWorkspaceContentProps) => {
  if (demoMode) return <DemoWorkspaceView onExit={onExitDemo} />

  return (
    <>
      {activeId ? (
        <WorkspaceTerminalPanels
          key={`terminal-${activeId}`}
          optimisticRuns={optimisticRunsByWorkspaceId[activeId] ?? []}
          workspaceId={activeId}
        />
      ) : null}
      <WorkspaceDetail
        onCreateWorker={workerActions.createWorker}
        onDeleteWorker={workerActions.deleteWorker}
        onDeleteWorkspace={onDeleteWorkspace}
        onStartWorker={workerActions.startWorker}
        onOrchestratorResult={recordOrchestratorResult}
        onRequestAddWorkspace={onRequestAddWorkspace}
        onTryDemo={onTryDemo}
        welcomeDisabledReason={bootstrapError ?? undefined}
        orchestratorAutostartError={
          activeId ? (orchestratorAutostartErrors[activeId] ?? null) : null
        }
        orchestratorAutostartRunId={
          activeId ? (orchestratorAutostartRunIds[activeId] ?? null) : null
        }
        terminalRuns={terminalRuns}
        workers={workers}
        workspace={activeWorkspace}
      />
    </>
  )
}
