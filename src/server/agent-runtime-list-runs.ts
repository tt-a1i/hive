import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const listRunsWithFallback = (
  registry: LiveRunRegistry,
  persistedRuns: PersistedAgentRun[],
  agentId: string
) => {
  if (persistedRuns.length > 0) {
    return persistedRuns
  }

  return registry
    .list()
    .filter((run) => run.agentId === agentId)
    .map(({ runId, pid, status, exitCode, startedAt }) => ({
      runId,
      agentId,
      pid,
      status,
      exitCode,
      startedAt,
      endedAt: status === 'exited' || status === 'error' ? Date.now() : null,
    }))
    .sort((left, right) => right.startedAt - left.startedAt)
}
