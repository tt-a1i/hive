import { delimiter, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import { completeLiveRun } from './agent-run-sync.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { withPresetResumeArgs } from './preset-launch-support.js'
import { captureSessionIdForCapture, snapshotSessionIdsForCapture } from './session-capture.js'

type PersistedRunStatus = PersistedAgentRun['status']

interface AgentRunStarterInput {
  agentManager: AgentManager | undefined
  registry: LiveRunRegistry
  onAgentExit: (workspaceId: string, agentId: string) => void
  store: {
    insertAgentRun: (
      runId: string,
      agentId: string,
      startedAt: number,
      pid: number | null,
      status?: PersistedRunStatus,
      exitCode?: number | null,
      endedAt?: number | null
    ) => void
    updatePersistedRun: (
      runId: string,
      status: PersistedRunStatus,
      exitCode: number | null,
      endedAt: number | null
    ) => void
  }
  sessionStore: AgentSessionStorePort
  tokenRegistry: AgentTokenRegistry
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
}

const resolveHiveBinDir = () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = resolve(moduleDir, '../..')
  return moduleDir.includes(`${sep}dist${sep}src${sep}`)
    ? resolve(packageRoot, 'bin')
    : resolve(packageRoot, 'dist/bin')
}

const HIVE_BIN_DIR = resolveHiveBinDir()

export const createAgentRunStarter =
  ({
    agentManager,
    registry,
    onAgentExit,
    store,
    sessionStore,
    tokenRegistry,
    getCommandPreset,
  }: AgentRunStarterInput) =>
  async (
    workspace: WorkspaceSummary,
    agentId: string,
    config: AgentLaunchConfigInput,
    hivePort: string
  ) => {
    if (!agentManager) throw new Error('Agent manager is required to start agents')

    const preset = config.commandPresetId ? getCommandPreset(config.commandPresetId) : undefined
    const startConfig = withPresetResumeArgs(
      config,
      preset,
      sessionStore.getLastSessionId(workspace.id, agentId),
      workspace.path
    )
    const knownSessionIds = snapshotSessionIdsForCapture(
      workspace.path,
      startConfig.sessionIdCapture
    )
    const handledRunExits = new Set<string>()
    const abortedRunIds = new Set<string>()
    const startedAt = Date.now()
    const token = tokenRegistry.issue(agentId)
    const startInput = {
      agentId,
      command: startConfig.command,
      cwd: workspace.path,
      env: {
        HIVE_PORT: hivePort,
        HIVE_PROJECT_ID: workspace.id,
        HIVE_AGENT_ID: agentId,
        HIVE_AGENT_TOKEN: token,
        PATH: `${HIVE_BIN_DIR}${delimiter}${process.env.PATH ?? ''}`,
      },
      onExit: ({ runId, exitCode }: { runId: string; exitCode: number | null }) => {
        const endedAt = Date.now()
        registry.setPendingExitCode(runId, exitCode)
        const liveRun = registry.get(runId)
        if (!liveRun) {
          if (abortedRunIds.has(runId)) {
            registry.clearPendingExitCode(runId)
          }
          tokenRegistry.revokeIfMatches(agentId, token)
          return
        }
        if (handledRunExits.has(runId)) {
          registry.clearPendingExitCode(runId)
          return
        }
        completeLiveRun(liveRun, exitCode, endedAt, store)
        if (exitCode !== 0 && startConfig.resumedSessionId) {
          sessionStore.clearLastSessionId(workspace.id, agentId)
        }
        handledRunExits.add(runId)
        tokenRegistry.revokeIfMatches(agentId, token)
        onAgentExit(workspace.id, agentId)
        registry.resolveExit(runId)
        // pendingExitCodes was only needed for the insert-before-exit race; after the
        // live-run path completes it's dead weight. liveRuns + runExitPromises are kept
        // so post-exit getLiveRun/close still work (bounded by agent start count).
        registry.clearPendingExitCode(runId)
      },
    }

    let run: Awaited<ReturnType<AgentManager['startAgent']>>
    try {
      run = await agentManager.startAgent(
        startConfig.args ? { ...startInput, args: startConfig.args } : startInput
      )
    } catch (error) {
      tokenRegistry.revokeIfMatches(agentId, token)
      throw error
    }
    const liveRun: LiveAgentRun = {
      ...run,
      exitCode: run.status === 'error' ? run.exitCode : null,
      startedAt,
      status: run.status === 'error' ? 'error' : 'starting',
    }
    try {
      store.insertAgentRun(run.runId, agentId, startedAt, run.pid, liveRun.status, liveRun.exitCode)
    } catch (error) {
      abortedRunIds.add(run.runId)
      registry.clearPendingExitCode(run.runId)
      tokenRegistry.revokeIfMatches(agentId, token)
      agentManager.stopRun(run.runId)
      throw error
    }
    registry.createExitEntry(run.runId)
    registry.add(liveRun)

    if (run.status === 'error') {
      store.updatePersistedRun(run.runId, 'error', run.exitCode, Date.now())
      if (startConfig.resumedSessionId) {
        sessionStore.clearLastSessionId(workspace.id, agentId)
      }
      tokenRegistry.revokeIfMatches(agentId, token)
      // Ensure §12 three-state: failed spawn must flip AgentSummary to stopped.
      onAgentExit(workspace.id, agentId)
      registry.resolveExit(run.runId)
      registry.clearPendingExitCode(run.runId)
      return liveRun
    }

    if (knownSessionIds && startConfig.sessionIdCapture) {
      void captureSessionIdForCapture(
        workspace.path,
        startConfig.sessionIdCapture,
        knownSessionIds,
        (sessionId) => {
          sessionStore.setLastSessionId(workspace.id, agentId, sessionId)
        }
      )
    }

    if (registry.hasPendingExitCode(run.runId)) {
      const exitCode = registry.getPendingExitCode(run.runId) ?? null
      queueMicrotask(() => {
        const pendingRun = registry.get(run.runId)
        if (!pendingRun) return
        if (handledRunExits.has(run.runId)) return
        completeLiveRun(pendingRun, exitCode, Date.now(), store)
        if (exitCode !== 0 && startConfig.resumedSessionId) {
          sessionStore.clearLastSessionId(workspace.id, agentId)
        }
        handledRunExits.add(run.runId)
        tokenRegistry.revokeIfMatches(agentId, token)
        onAgentExit(workspace.id, agentId)
        registry.resolveExit(run.runId)
        registry.clearPendingExitCode(run.runId)
      })
    }

    return liveRun
  }
