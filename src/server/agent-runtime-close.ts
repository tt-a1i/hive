import type { AgentManager } from './agent-manager.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const closeAgentRuntime = async (
  agentManager: AgentManager | undefined,
  registry: LiveRunRegistry,
  syncRun: (run: LiveAgentRun) => LiveAgentRun
) => {
  const runs = registry.list()
  for (const run of runs) {
    syncRun(run)
    agentManager?.stopRun(run.runId)
  }

  await Promise.all(registry.listExitEntries().map((entry) => entry.promise))

  for (const run of registry.list()) {
    agentManager?.removeRun(run.runId)
    registry.remove(run.runId)
  }
}
