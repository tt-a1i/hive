import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const getActiveRunByAgent = (
  registry: LiveRunRegistry,
  getWorkspaceId: (agentId: string) => string | undefined,
  syncRun: (run: LiveAgentRun) => LiveAgentRun,
  workspaceId: string,
  agentId: string
) => {
  return registry
    .list()
    .filter((run) => run.agentId === agentId && getWorkspaceId(run.agentId) === workspaceId)
    .sort((left, right) => right.startedAt - left.startedAt)
    .find((run) => {
      const status = syncRun(run).status
      return status === 'starting' || status === 'running'
    })
}
