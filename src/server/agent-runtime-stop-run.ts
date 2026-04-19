import type { AgentManager } from './agent-manager.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const stopLiveRun = (
  agentManager: AgentManager | undefined,
  registry: LiveRunRegistry,
  syncRun: (run: LiveAgentRun) => LiveAgentRun,
  runId: string
) => {
  if (!agentManager) {
    throw new Error('Agent manager is required to stop agents')
  }

  const liveRun = registry.get(runId)
  if (liveRun) {
    const status = syncRun(liveRun).status
    if (status === 'exited' || status === 'error') {
      return
    }
  } else if (['error', 'exited'].includes(agentManager.getRun(runId).status)) {
    return
  }

  agentManager.stopRun(runId)
}
