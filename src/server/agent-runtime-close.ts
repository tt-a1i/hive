import type { AgentManager } from './agent-manager.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const AGENT_RUNTIME_CLOSE_TIMEOUT_MS = 5000

const waitForExitEntries = async (
  entries: Array<{ promise: Promise<unknown>; runId: string }>,
  timeoutMs = AGENT_RUNTIME_CLOSE_TIMEOUT_MS
) => {
  if (entries.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
  })
  try {
    const result = await Promise.race([
      Promise.all(entries.map((entry) => entry.promise)).then(() => 'done' as const),
      timeout,
    ])
    if (result === 'timeout') {
      const runIds = entries.map((entry) => entry.runId).join(', ')
      console.error(`[hive] timed out waiting for agent exit during shutdown: ${runIds}`)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const closeAgentRuntime = async (
  agentManager: AgentManager | undefined,
  registry: LiveRunRegistry,
  syncRun: (run: LiveAgentRun) => LiveAgentRun
) => {
  const runs = registry.list()
  for (const run of runs) {
    run.captureController?.abort()
    syncRun(run)
    agentManager?.stopRun(run.runId)
  }

  await waitForExitEntries(registry.listExitEntries())

  for (const run of registry.list()) {
    agentManager?.removeRun(run.runId)
    registry.remove(run.runId)
  }
}
