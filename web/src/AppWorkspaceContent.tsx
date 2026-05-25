import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import type { OrchestratorStartResult, TerminalRunSummary } from './api.js'
import { DemoWorkspaceView } from './demo/DemoWorkspaceView.js'
import type { useTasksFile } from './tasks/useTasksFile.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'
import type { WorkerActions } from './worker/useWorkerActions.js'

type TasksFileApi = ReturnType<typeof useTasksFile>

type AppWorkspaceContentProps = {
  activeId: string | undefined
  activeWorkspace: WorkspaceSummary | undefined
  bootstrapError: string | null
  demoMode: boolean
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onExitDemo: () => void
  onRequestAddWorkspace: () => void
  onShellRunClosed: (workspaceId: string, runId: string) => void
  onShellRunStarted: (workspaceId: string, run: TerminalRunSummary) => void
  onTryDemo: () => void
  optimisticRunsByWorkspaceId: Record<string, TerminalRunSummary[]>
  orchestratorAutostartErrors: Record<string, string | null>
  orchestratorAutostartRunIds: Record<string, string | null>
  recordOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  tasksFile: TasksFileApi
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
  onShellRunClosed,
  onShellRunStarted,
  onTryDemo,
  optimisticRunsByWorkspaceId,
  orchestratorAutostartErrors,
  orchestratorAutostartRunIds,
  recordOrchestratorResult,
  tasksFile,
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
          terminalRuns={terminalRuns}
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
        onShellRunClosed={onShellRunClosed}
        onShellRunStarted={onShellRunStarted}
        onTryDemo={onTryDemo}
        welcomeDisabledReason={bootstrapError ?? undefined}
        orchestratorAutostartError={
          activeId ? (orchestratorAutostartErrors[activeId] ?? null) : null
        }
        orchestratorAutostartRunId={
          activeId ? (orchestratorAutostartRunIds[activeId] ?? null) : null
        }
        tasksFile={tasksFile}
        terminalRuns={terminalRuns}
        workers={workers}
        workspace={activeWorkspace}
      />
    </>
  )
}
