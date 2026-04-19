import type { AgentManager } from './agent-manager.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const closeAgentRuntime = async (
  agentManager: AgentManager | undefined,
  registry: LiveRunRegistry,
  syncRun: (run: LiveAgentRun) => LiveAgentRun
) => {
  const activeRuns = registry.list().filter((run) => {
    const status = syncRun(run).status
    return status === 'starting' || status === 'running'
  })

  for (const run of activeRuns) {
    agentManager?.stopRun(run.runId)
  }

  await Promise.all(registry.listExitEntries().map((entry) => entry.promise))

  for (const run of registry.list()) {
    registry.remove(run.runId)
  }
}
