import type { WorkspaceSummary } from '../shared/types.js'
import { createAgentLaunchCache } from './agent-launch-cache.js'
import type { AgentManager } from './agent-manager.js'
import { createAgentRunStarter } from './agent-run-starter.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import { syncPersistedRun } from './agent-run-sync.js'
import { getActiveRunByAgent } from './agent-runtime-active-run.js'
import { closeAgentRuntime } from './agent-runtime-close.js'
import { listRunsWithFallback } from './agent-runtime-list-runs.js'
import type { AgentRunStorePort, AgentSessionStorePort } from './agent-runtime-ports.js'
import { stopLiveRun } from './agent-runtime-stop-run.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentStdinDispatcher } from './agent-stdin-dispatcher.js'
import { type AgentTokenRegistry, createAgentTokenRegistry } from './agent-tokens.js'
import { withClaudeResumeArgs } from './claude-session-support.js'
import { createLiveRunRegistry } from './live-run-registry.js'
import type { PtyOutputBus } from './pty-output-bus.js'

interface StartAgentOptions {
  hivePort: string
}

export interface AgentRuntime {
  close: () => Promise<void>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  getLiveRun: (runId: string) => LiveAgentRun
  getPtyOutputBus: () => PtyOutputBus
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  peekAgentToken: (agentId: string) => string | undefined
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  startAgent: (
    workspace: WorkspaceSummary,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  stopAgentRun: (runId: string) => void
  validateAgentToken: AgentTokenRegistry['validate']
  writeReportPrompt: (
    workspaceId: string,
    workerName: string,
    workerId: string,
    text: string,
    status: string,
    artifacts: string[],
    input?: { requireActiveRun?: boolean }
  ) => void
  writeSendPrompt: (
    workspaceId: string,
    workerId: string,
    fromAgentName: string,
    workerDescription: string,
    text: string
  ) => void
  writeUserInputPrompt: (workspaceId: string, text: string) => void
}

export const createAgentRuntime = (
  agentManager: AgentManager | undefined,
  agentRunStore: AgentRunStorePort,
  sessionStore: AgentSessionStorePort,
  onAgentExit: (workspaceId: string, agentId: string) => void
): AgentRuntime => {
  const registry = createLiveRunRegistry()
  const launchCache = createAgentLaunchCache(agentRunStore)
  const tokenRegistry = createAgentTokenRegistry()
  const requireManager = () => {
    if (!agentManager) throw new Error('Agent manager is required for PTY terminal operations')
    return agentManager
  }

  const syncRun = (run: LiveAgentRun) =>
    agentManager ? syncPersistedRun(run, agentManager.getRun(run.runId), agentRunStore) : run
  const stdinDispatcher = createAgentStdinDispatcher({
    agentManager,
    getWorkspaceId: launchCache.getWorkspaceId,
    registry,
    syncRun,
  })
  const startLiveRun = createAgentRunStarter({
    agentManager,
    registry,
    onAgentExit,
    store: agentRunStore,
    sessionStore,
    tokenRegistry,
  })

  return {
    async close() {
      await closeAgentRuntime(agentManager, registry, syncRun)
    },
    configureAgentLaunch(workspaceId, agentId, input) {
      launchCache.save(workspaceId, agentId, input)
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
    getLiveRun(runId) {
      const run = registry.get(runId)
      if (!run) throw new Error(`Live run not found: ${runId}`)
      return syncRun(run)
    },
    getPtyOutputBus() {
      return requireManager().getOutputBus()
    },
    listAgentRuns(agentId) {
      return listRunsWithFallback(registry, agentRunStore.listAgentRuns(agentId), agentId)
    },
    peekAgentToken(agentId) {
      return tokenRegistry.peek(agentId)
    },
    resizeAgentRun(runId, cols, rows) {
      requireManager().resizeRun(runId, cols, rows)
    },
    async startAgent(workspace, agentId, input) {
      const config = withClaudeResumeArgs(
        launchCache.get(workspace.id, agentId),
        sessionStore.getLastSessionId(workspace.id, agentId),
        workspace.path
      )
      launchCache.setWorkspaceId(agentId, workspace.id)
      return startLiveRun(workspace, agentId, config, input.hivePort)
    },
    stopAgentRun(runId) {
      stopLiveRun(agentManager, registry, syncRun, runId)
    },
    validateAgentToken: tokenRegistry.validate,
    writeReportPrompt(workspaceId, workerName, _workerId, text, status, artifacts, input = {}) {
      stdinDispatcher.writeReportPrompt(workspaceId, workerName, text, status, artifacts, input)
    },
    writeSendPrompt(workspaceId, workerId, fromAgentName, workerDescription, text) {
      stdinDispatcher.writeSendPrompt(workspaceId, workerId, fromAgentName, workerDescription, text)
    },
    writeUserInputPrompt(workspaceId, text) {
      stdinDispatcher.writeUserInputPrompt(workspaceId, text)
    },
  }
}
