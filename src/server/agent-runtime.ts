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
import { ConflictError } from './http-errors.js'
import { createLiveRunRegistry } from './live-run-registry.js'
import { autostartAgent } from './orchestrator-autostart.js'
import { createNoopRestartPolicy, type RestartPolicy } from './restart-policy.js'
import type { TeamMemoryInjectionService } from './team-memory-injection.js'

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
  onAgentExit: (workspaceId: string, agentId: string, replacing?: boolean) => void,
  restartPolicy: RestartPolicy = createNoopRestartPolicy(),
  getAgent?: (workspaceId: string, agentId: string) => AgentSummary | undefined,
  getFlags?: () => FeatureFlags,
  memoryInjection?: TeamMemoryInjectionService,
  transaction?: (write: () => void) => void
): AgentRuntime => {
  const registry = createLiveRunRegistry()
  const launchCache = createAgentLaunchCache(agentRunStore, transaction)
  const tokenRegistry = createAgentTokenRegistry()
  const startPromises = new Map<string, Promise<LiveAgentRun>>()
  const switchPromises = new Map<string, Promise<LiveAgentRun>>()
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
    ...(memoryInjection ? { memoryInjection } : {}),
  })
  const startLiveRun = createAgentRunStarter({
    agentManager,
    registry,
    onAgentExit: (workspaceId, agentId) =>
      onAgentExit(workspaceId, agentId, switchPromises.has(`${workspaceId}:${agentId}`)),
    store: agentRunStore,
    sessionStore,
    getLaunchConfigVersion: launchCache.getVersion,
    tokenRegistry,
    getCommandPreset,
    getAgent,
    restartPolicy,
    ...(getFlags ? { getFlags } : {}),
    ...(memoryInjection ? { memoryInjection } : {}),
  })

  const configureLaunch: AgentRuntime['configureAgentLaunch'] = (workspaceId, agentId, input) => {
    const previous = launchCache.peek(workspaceId, agentId)
    const changedCli =
      previous &&
      (previous.command !== input.command ||
        previous.commandPresetId !== (input.commandPresetId ?? null))
    launchCache.save(
      workspaceId,
      agentId,
      input,
      changedCli ? () => sessionStore.clearLastSessionId(workspaceId, agentId) : undefined
    )
  }

  const runtime: AgentRuntime = {
    async close() {
      closing = true
      await Promise.allSettled([...startPromises.values(), ...switchPromises.values()])
      await closeAgentRuntime(agentManager, registry, syncRun)
    },
    configureAgentLaunch(workspaceId, agentId, input) {
      if (switchPromises.has(`${workspaceId}:${agentId}`))
        throw new ConflictError('Agent CLI switch is in progress')
      configureLaunch(workspaceId, agentId, input)
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
      const switching = switchPromises.get(key)
      if (switching) return switching
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
    switchAgent(workspace, agentId, config, input) {
      if (closing) return Promise.reject(new ConflictError('Agent runtime is closing'))
      if (workspace.controller_mode === 'codex_app' && agentId === `${workspace.id}:orchestrator`)
        return Promise.reject(new ConflictError('This workspace uses Codex App as its controller'))
      const key = `${workspace.id}:${agentId}`
      if (switchPromises.has(key))
        return Promise.reject(new ConflictError('Agent CLI switch is in progress'))
      const switching = Promise.resolve()
        .then(async () => {
          await Promise.allSettled([startPromises.get(key)])
          const liveRuns = registry.list().filter((run) => {
            if (run.agentId !== agentId) return false
            const status = syncRun(run).status
            return status === 'starting' || status === 'running'
          })
          for (const run of liveRuns) {
            runtime.stopAgentRun(run.runId)
            if (!(await runtime.waitForRunExit(run.runId, 10_000)))
              throw new ConflictError('Timed out waiting for the previous CLI to stop')
          }
          if (closing) throw new ConflictError('Agent runtime is closing')
          configureLaunch(workspace.id, agentId, config)
          // Keep handover protection until the replacement's early-exit
          // window has settled, including a CLI that exits with code zero.
          const result = await autostartAgent(
            {
              startAgent: () =>
                startLiveRun(
                  workspace,
                  agentId,
                  launchCache.get(workspace.id, agentId),
                  input.hivePort
                ),
              getLiveRun: runtime.getLiveRun,
              waitForRunExit: runtime.waitForRunExit,
              peekAgentLaunchConfig: launchCache.peek,
            },
            workspace.id,
            agentId,
            input.hivePort,
            { missingConfigError: 'Agent launch config not found', requireRunning: true }
          )
          if (!result.ok || !result.run_id)
            throw new Error(result.error ?? 'Replacement CLI failed to start')
          return runtime.getLiveRun(result.run_id)
        })
        .finally(() => switchPromises.delete(key))
      switchPromises.set(key, switching)
      return switching
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
  return runtime
}

export type { AgentRuntime }
