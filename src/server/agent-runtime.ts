import type { AgentSummary } from '../shared/types.js'
import { createAgentLaunchCache } from './agent-launch-cache.js'
import type { AgentManager } from './agent-manager.js'
import { createAgentRunStarter } from './agent-run-starter.js'
import { syncPersistedRun } from './agent-run-sync.js'
import { getActiveRunByAgent } from './agent-runtime-active-run.js'
import { closeAgentRuntime } from './agent-runtime-close.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { createAgentRuntimeFlowAdapter } from './agent-runtime-flow-adapter.js'
import { listRunsWithFallback } from './agent-runtime-list-runs.js'
import type { AgentRunStorePort, AgentSessionStorePort } from './agent-runtime-ports.js'
import { stopLiveRun } from './agent-runtime-stop-run.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentStdinDispatcher } from './agent-stdin-dispatcher.js'
import { createAgentTokenRegistry } from './agent-tokens.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { FeatureFlags } from './feature-flags.js'
import { createLiveRunRegistry } from './live-run-registry.js'
import { createNoopRestartPolicy, type RestartPolicy } from './restart-policy.js'

const waitForExitEntry = async (promise: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  if (timeoutMs <= 0) return false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export const createAgentRuntime = (
  agentManager: AgentManager | undefined,
  agentRunStore: AgentRunStorePort,
  sessionStore: AgentSessionStorePort,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined,
  onAgentExit: (workspaceId: string, agentId: string) => void,
  restartPolicy: RestartPolicy = createNoopRestartPolicy(),
  getAgent?: (workspaceId: string, agentId: string) => AgentSummary | undefined,
  getFlags?: () => FeatureFlags
): AgentRuntime => {
  const registry = createLiveRunRegistry()
  const launchCache = createAgentLaunchCache(agentRunStore)
  const tokenRegistry = createAgentTokenRegistry()
  const startPromises = new Map<string, Promise<LiveAgentRun>>()
  let closing = false
  const requireManager = () => {
    if (!agentManager) throw new Error('Agent manager is required for PTY terminal operations')
    return agentManager
  }
  const flowAdapter = createAgentRuntimeFlowAdapter(requireManager)

  const syncRun = (run: LiveAgentRun) =>
    agentManager ? syncPersistedRun(run, agentManager.getRun(run.runId), agentRunStore) : run
  const stdinDispatcher = createAgentStdinDispatcher({
    agentManager,
    getLaunchConfig: launchCache.peek,
    getWorkspaceId: launchCache.getWorkspaceId,
    registry,
    syncRun,
    ...(getFlags ? { getFlags } : {}),
  })
  const startLiveRun = createAgentRunStarter({
    agentManager,
    registry,
    onAgentExit,
    store: agentRunStore,
    sessionStore,
    tokenRegistry,
    getCommandPreset,
    getAgent,
    restartPolicy,
    ...(getFlags ? { getFlags } : {}),
  })

  return {
    async close() {
      closing = true
      await Promise.allSettled([...startPromises.values()])
      await closeAgentRuntime(agentManager, registry, syncRun)
    },
    configureAgentLaunch(workspaceId, agentId, input) {
      launchCache.save(workspaceId, agentId, input)
    },
    deleteAgentLaunchConfig(workspaceId, agentId) {
      launchCache.remove(workspaceId, agentId)
    },
    peekAgentLaunchConfig(workspaceId, agentId) {
      return launchCache.peek(workspaceId, agentId)
    },
    getActiveRunByAgentId(workspaceId, agentId) {
      return getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspaceId,
        agentId
      )
    },
    findLiveRun(runId) {
      const run = registry.get(runId)
      return run ? syncRun(run) : undefined
    },
    getLiveRun(runId) {
      const run = registry.get(runId)
      if (!run) throw new Error(`Live run not found: ${runId}`)
      return syncRun(run)
    },
    waitForRunExit(runId, timeoutMs) {
      const entry = registry.getExitEntry(runId)
      if (!entry) return Promise.resolve(false)
      return waitForExitEntry(entry.promise, timeoutMs)
    },
    getPtyOutputBus() {
      return flowAdapter.getOutputBus()
    },
    listAgentRuns(agentId) {
      return listRunsWithFallback(registry, agentRunStore.listAgentRuns(agentId), agentId)
    },
    pauseRun(runId) {
      flowAdapter.pauseRun(runId)
    },
    peekAgentToken(agentId) {
      return tokenRegistry.peek(agentId)
    },
    resizeAgentRun(runId, cols, rows) {
      flowAdapter.resizeRun(runId, cols, rows)
    },
    resumeRun(runId) {
      flowAdapter.resumeRun(runId)
    },
    async startAgent(workspace, agentId, input) {
      if (closing) throw new Error('Agent runtime is closing')
      launchCache.setWorkspaceId(agentId, workspace.id)
      const key = `${workspace.id}:${agentId}`
      const activeRun = getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspace.id,
        agentId
      )
      if (activeRun) return activeRun
      const pendingStart = startPromises.get(key)
      if (pendingStart) return pendingStart
      const startPromise = startLiveRun(
        workspace,
        agentId,
        launchCache.get(workspace.id, agentId),
        input.hivePort
      ).finally(() => {
        if (startPromises.get(key) === startPromise) {
          startPromises.delete(key)
        }
      })
      startPromises.set(key, startPromise)
      return startPromise
    },
    stopAgentRun(runId) {
      stopLiveRun(agentManager, registry, syncRun, runId, (stoppedRunId) => {
        const liveRun = registry.get(stoppedRunId)
        if (liveRun) liveRun.userStopped = true
        restartPolicy.markUserStopped(stoppedRunId)
      })
    },
    validateAgentToken: tokenRegistry.validate,
    writeStatusPrompt(workspaceId, workerName, _workerId, text, artifacts, input = {}) {
      return stdinDispatcher.writeStatusPrompt(workspaceId, workerName, text, artifacts, input)
    },
    writeSendPrompt(
      workspaceId,
      workerId,
      dispatchId,
      fromAgentName,
      workerDescription,
      text,
      requiredSeenSeq,
      input = {}
    ) {
      return stdinDispatcher.writeSendPrompt(
        workspaceId,
        workerId,
        dispatchId,
        fromAgentName,
        workerDescription,
        text,
        requiredSeenSeq,
        input
      )
    },
    writeCancelPrompt(workspaceId, workerId, dispatchId, reason, input = {}) {
      return stdinDispatcher.writeCancelPrompt(workspaceId, workerId, dispatchId, reason, input)
    },
    writeUserInputPrompt(workspaceId, text) {
      stdinDispatcher.writeUserInputPrompt(workspaceId, text)
    },
    writeSystemMessageToAgent(workspaceId, agentId, text) {
      stdinDispatcher.writeSystemMessageToAgent(workspaceId, agentId, text)
    },
    deliverUserInputToOrchestrator(workspaceId, text, input = {}) {
      return stdinDispatcher.deliverUserInputToOrchestrator(workspaceId, text, input)
    },
    deliverSystemMessageToAgent(workspaceId, agentId, text, input = {}) {
      return stdinDispatcher.deliverSystemMessageToAgent(workspaceId, agentId, text, input)
    },
  }
}

export type { AgentRuntime }
