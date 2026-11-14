import { ConflictError } from './http-errors.js'
import type { RuntimeStore } from './runtime-store-contract.js'
import type { createRuntimeStoreLifecycle, RuntimeStoreServices } from './runtime-store-helpers.js'

export const createRuntimeStoreAgentSwitch =
  (
    services: RuntimeStoreServices,
    lifecycle: ReturnType<typeof createRuntimeStoreLifecycle>
  ): RuntimeStore['switchAgentLaunch'] =>
  async (workspaceId, agentId, config, input) => {
    const agent = services.workspaceStore.getAgent(workspaceId, agentId)
    if (agent.role === 'workflow' || agent.spawnedBy === 'workflow')
      throw new ConflictError(
        'Workflow-managed members must keep their workflow launch configuration.'
      )
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary
    const run = await services.agentRuntime.switchAgentLaunch(
      workspace,
      agentId,
      () => lifecycle.configureAgentLaunchUnlocked(workspaceId, agentId, config),
      input
    )
    if (!run) return null
    // Attach and drain the exact replacement; never spawn again after a late stop/exit.
    if (services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)?.runId !== run.runId)
      throw new ConflictError(
        'Agent stopped before CLI handover completed. Start it explicitly to retry.'
      )
    lifecycle.completeAgentStart(workspaceId, agentId, run)
    return run
  }
