import { LoaderCircle } from 'lucide-react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import type { OrchestratorStartResult, TerminalRunSummary } from './api.js'
import { DemoWorkspaceView } from './demo/DemoWorkspaceView.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import type { WorkerActions } from './worker/useWorkerActions.js'

type AppWorkspaceContentProps = {
  activeId: string | undefined
  activeWorkspace: WorkspaceSummary | undefined
  activeWorkerId?: string | null
  bootstrapError: string | null
  demoMode: boolean
  onActiveWorkerChange?: (workerId: string | null) => void
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onExitDemo: () => void
  onOrchestratorRunClosed: (workspaceId: string, runId: string) => void
  onRequestAddWorkspace: () => void
  onShellRunClosed: (workspaceId: string, runId: string) => void
  onShellRunStarted: (workspaceId: string, run: TerminalRunSummary) => void
  onTryDemo: () => void
  orchestratorAutostartErrors: Record<string, string | null>
  recordOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  terminalRuns: TerminalRunSummary[]
  workerActions: WorkerActions
  workers: TeamListItem[]
  workspacesLoading?: boolean
  showInlineActionCenter?: boolean
}

export const AppWorkspaceContent = ({
  activeId,
  activeWorkspace,
  activeWorkerId,
  bootstrapError,
  demoMode,
  onActiveWorkerChange,
  onDeleteWorkspace,
  onExitDemo,
  onOrchestratorRunClosed,
  onRequestAddWorkspace,
  onShellRunClosed,
  onShellRunStarted,
  onTryDemo,
  orchestratorAutostartErrors,
  recordOrchestratorResult,
  terminalRuns,
  workerActions,
  workers,
  workspacesLoading,
  showInlineActionCenter,
}: AppWorkspaceContentProps) => {
  if (demoMode) return <DemoWorkspaceView onExit={onExitDemo} />

  if (workspacesLoading && !activeWorkspace) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoaderCircle size={24} className="animate-spin text-ter" />
      </div>
    )
  }

  return (
    <WorkspaceDetail
      {...(activeWorkerId !== undefined ? { activeWorkerId } : {})}
      onCreateWorker={workerActions.createWorker}
      onDeleteWorker={workerActions.deleteWorker}
      onDeleteWorkspace={onDeleteWorkspace}
      onUpdateWorkerAvatar={workerActions.updateWorkerAvatar}
      onStartWorker={workerActions.startWorker}
      onStopWorker={workerActions.stopWorkerRun}
      onRestartWorker={workerActions.restartWorkerRun}
      onOrchestratorResult={recordOrchestratorResult}
      onOrchestratorRunClosed={onOrchestratorRunClosed}
      onRequestAddWorkspace={onRequestAddWorkspace}
      onShellRunClosed={onShellRunClosed}
      onShellRunStarted={onShellRunStarted}
      onTryDemo={onTryDemo}
      {...(onActiveWorkerChange ? { onActiveWorkerChange } : {})}
      {...(bootstrapError !== null ? { welcomeDisabledReason: bootstrapError } : {})}
      orchestratorAutostartError={activeId ? (orchestratorAutostartErrors[activeId] ?? null) : null}
      terminalRuns={terminalRuns}
      workers={workers}
      workspace={activeWorkspace}
      {...(showInlineActionCenter !== undefined ? { showInlineActionCenter } : {})}
    />
  )
}
