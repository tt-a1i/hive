import { AppWorkspaceContent } from './AppWorkspaceContent.js'
import { RuntimeOfflinePage } from './pwa/RuntimeOfflinePage.js'
import type { AppWorkspace } from './useAppWorkspace.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'

export const AppWorkspaceView = ({
  workspace,
  activeWorkerId,
  onActiveWorkerChange,
  onAddWorkspace,
  isMobile,
}: {
  workspace: AppWorkspace
  activeWorkerId: string | null
  onActiveWorkerChange: (id: string | null) => void
  onAddWorkspace: () => void
  isMobile: boolean
}) => {
  const { activeId, effective, terms, create } = workspace
  return workspace.runtimeOffline ? (
    <RuntimeOfflinePage onTryDemo={workspace.enableDemo} />
  ) : (
    <AppWorkspaceContent
      activeId={activeId}
      activeWorkspace={effective.effectiveActiveWorkspace}
      activeWorkerId={activeWorkerId}
      bootstrapError={workspace.bootstrapError}
      demoMode={workspace.demoMode}
      workspacesLoading={!workspace.demoMode && workspace.workspaces === null}
      onActiveWorkerChange={onActiveWorkerChange}
      onDeleteWorkspace={workspace.deleteWorkspace}
      onExitDemo={workspace.exitDemo}
      onOrchestratorRunClosed={terms.forgetOptimisticRun}
      onRequestAddWorkspace={onAddWorkspace}
      onShellRunClosed={terms.forgetOptimisticRun}
      onShellRunStarted={(workspaceId, run) =>
        terms.recordOptimisticRun({
          agentId: run.agent_id,
          agentName: run.agent_name,
          runId: run.run_id,
          status: run.status,
          terminalInputProfile: run.terminal_input_profile ?? 'default',
          workspaceId,
        })
      }
      onTryDemo={workspace.enableDemo}
      orchestratorAutostartErrors={create.orchestratorAutostartErrors}
      recordOrchestratorResult={create.recordOrchestratorResult}
      terminalRuns={terms.terminalRuns}
      workerActions={workspace.workerActions}
      workers={workspace.activeWorkers}
      showInlineActionCenter={isMobile}
    />
  )
}

/** Kept outside section content so mobile navigation never unmounts terminals. */
export const AppTerminalPanels = ({ workspace }: { workspace: AppWorkspace }) => {
  const { activeId, terms } = workspace
  const optimisticRuns = activeId ? (terms.optimisticRunsByWorkspaceId[activeId] ?? []) : []
  if (
    workspace.runtimeOffline ||
    workspace.demoMode ||
    activeId === undefined ||
    (terms.terminalRuns.length === 0 && optimisticRuns.length === 0)
  )
    return null
  return (
    <WorkspaceTerminalPanels
      key={`terminal-${activeId}`}
      onTerminalRunExited={terms.forgetOptimisticRun}
      optimisticRuns={optimisticRuns}
      terminalRuns={terms.terminalRuns}
      workspaceId={activeId}
    />
  )
}
