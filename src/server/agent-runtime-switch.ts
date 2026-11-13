import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { ConflictError } from './http-errors.js'
import { autostartAgent } from './orchestrator-autostart.js'

type SwitchRuntime = Pick<
  AgentRuntime,
  'peekAgentLaunchConfig' | 'getLiveRun' | 'waitForRunExit' | 'stopAgentRun'
> & {
  startAgent: AgentRuntime['startAgent']
  listLiveRuns: () => LiveAgentRun[]
  pendingStart: (workspaceId: string, agentId: string) => Promise<LiveAgentRun> | undefined
  isClosing: () => boolean
}

/** One explicit handover owns stop, configuration commit and startup. */
export const createAgentRuntimeSwitch = (ports: SwitchRuntime) => {
  const switches = new Set<string>()
  const key = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`
  const isAgentSwitching = (workspaceId: string, agentId: string) =>
    switches.has(key(workspaceId, agentId))
  const assertAvailable = (workspaceId: string, agentId: string) => {
    if (isAgentSwitching(workspaceId, agentId))
      throw new ConflictError('Agent CLI switch is in progress. Wait for it to finish.')
  }
  const stopAndWait = async (agentId: string) => {
    for (const run of ports.listLiveRuns().filter((item) => item.agentId === agentId)) {
      const current = ports.getLiveRun(run.runId)
      if (current.status === 'error' || current.status === 'exited') continue
      ports.stopAgentRun(run.runId)
      if (!(await ports.waitForRunExit(run.runId, 10000)))
        throw new ConflictError('The previous agent process has not exited. Retry after it stops.')
    }
  }
  return {
    isAgentSwitching,
    assertAvailable,
    async switchAgentLaunch(
      workspace: WorkspaceSummary,
      agentId: string,
      configure: () => void,
      input: { hivePort: string; restart: boolean }
    ) {
      assertAvailable(workspace.id, agentId)
      if (ports.isClosing()) throw new ConflictError('Runtime is closing')
      const agentKey = key(workspace.id, agentId)
      switches.add(agentKey)
      try {
        const pending = ports.pendingStart(workspace.id, agentId)
        if (pending) await Promise.allSettled([pending])
        await stopAndWait(agentId)
        if (ports.isClosing()) throw new ConflictError('Runtime is closing')
        configure()
        if (!input.restart) return null
        const result = await autostartAgent(
          {
            ...ports,
            startAgent: (_workspaceId, id, options) => ports.startAgent(workspace, id, options),
          },
          workspace.id,
          agentId,
          input.hivePort,
          { missingConfigError: 'No agent launch config available' }
        )
        if (!result.ok || !result.run_id)
          throw new ConflictError(result.error ?? 'Agent failed to start')
        const run = ports.getLiveRun(result.run_id)
        if (run.postStartInputReady) await run.postStartInputReady
        const current = ports.getLiveRun(run.runId)
        if (current.userStopped || current.status === 'exited' || current.status === 'error')
          throw new ConflictError(
            `Agent exited during CLI switch (exit ${current.exitCode ?? 'unknown'}). Check the terminal output and retry.`
          )
        if (ports.isClosing()) throw new ConflictError('Runtime is closing')
        return current
      } catch (error) {
        await stopAndWait(agentId)
        throw error
      } finally {
        switches.delete(agentKey)
      }
    },
  }
}
