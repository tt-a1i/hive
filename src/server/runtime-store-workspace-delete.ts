import type { RuntimeStore } from './runtime-store-contract.js'
import type { createRuntimeStoreLifecycle, RuntimeStoreServices } from './runtime-store-helpers.js'
import type { StagedWorkspaceUploadsDelete } from './workspace-upload-store.js'

export const createRuntimeStoreWorkspaceDelete = (
  services: RuntimeStoreServices,
  lifecycle: ReturnType<typeof createRuntimeStoreLifecycle>,
  runDataMutation: (mutation: () => void) => void
): RuntimeStore['deleteWorkspace'] => {
  return async (workspaceId) => {
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
    lifecycle.deleteWorkspaceShell(workspaceId)
    for (const agent of workspace.agents) {
      const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
      if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
      services.agentRuntime.deleteAgentLaunchConfig(workspaceId, agent.id)
    }
    await services.tasksFileWatcher.stop(workspaceId)
    // Upload blobs are only tombstoned (renamed) inside the transaction and
    // permanently unlinked after COMMIT, so a failed commit restores them
    // instead of resurrecting a workspace whose attachments all 404.
    let stagedUploads: StagedWorkspaceUploadsDelete | undefined
    try {
      runDataMutation(() => {
        services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
        services.workspaceStore.deleteWorkspaceData(workspaceId)
        stagedUploads = services.workspaceUploadStore.stageWorkspaceUploadsDelete(workspaceId)
      })
    } catch (error) {
      stagedUploads?.rollback()
      throw error
    }
    stagedUploads?.commit()
    services.workspaceStore.forgetWorkspace(workspaceId)
    if (services.settings.getAppState('active_workspace_id')?.value === workspaceId) {
      services.settings.setAppState('active_workspace_id', null)
    }
  }
}
