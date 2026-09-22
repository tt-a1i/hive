import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import { classifyCompletedRunStatus } from './agent-exit-classification.js'
import type { AgentManager } from './agent-manager.js'
import { buildAgentRunBootstrap, startAgentRunCapture } from './agent-run-bootstrap.js'
import { handleAgentRunExit } from './agent-run-exit-handler.js'
import type { AgentRunExitContext, AgentRunStarterStorePort } from './agent-run-start-context.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { logAgentStartupFailure } from './agent-startup-diagnostics.js'
import {
  buildAgentStartupInstructions,
  buildWorkflowAgentStartupInstructions,
} from './agent-startup-instructions.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import { ensureClaudeDirectoryTrusted } from './claude-trust-store.js'
import { codexTeamEnvironmentArgs } from './codex-team-environment.js'
import { ensureCodexDirectoryTrusted } from './codex-trust-store.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { FEATURE_FLAGS_ALL_OFF, type FeatureFlags } from './feature-flags.js'
import { ConflictError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import {
  createPostStartInputWriter,
  isInteractiveAgentCommand,
  waitForPostStartInputReady,
} from './post-start-input-writer.js'
import { isResumeLaunchConfig } from './preset-launch-support.js'
import type { RestartPolicy } from './restart-policy.js'
import { clearResumedSessionAfterExitIfStale } from './resumed-session-cleanup.js'
import { normalizeExecutableToken } from './startup-command-parser.js'
import {
  buildMemoryDigestSafely,
  logMemoryDigestInjection,
  rollbackMemoryDigestInjection,
  type TeamMemoryInjectionService,
} from './team-memory-injection.js'

interface AgentRunStarterInput {
  agentManager: AgentManager | undefined
  registry: LiveRunRegistry
  onAgentExit: (workspaceId: string, agentId: string) => void
  store: AgentRunStarterStorePort
  sessionStore: AgentSessionStorePort
  tokenRegistry: AgentTokenRegistry
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
  getAgent: ((workspaceId: string, agentId: string) => AgentSummary | undefined) | undefined
  restartPolicy: RestartPolicy
  /** Resolves the live experimental flags for the orchestrator's startup
   *  prompt (`workflowsEnabled` gates the `team workflow` line + authoring
   *  rule). */
  getFlags?: () => FeatureFlags
  memoryInjection?: TeamMemoryInjectionService
}

export const createAgentRunStarter =
  ({
    agentManager,
    registry,
    onAgentExit,
    store,
    sessionStore,
    tokenRegistry,
    getCommandPreset,
    getAgent,
    restartPolicy,
    getFlags,
    memoryInjection,
  }: AgentRunStarterInput) =>
  async (
    workspace: WorkspaceSummary,
    agentId: string,
    config: AgentLaunchConfigInput,
    hivePort: string
  ) => {
    if (workspace.controller_mode === 'codex_app' && agentId === `${workspace.id}:orchestrator`)
      throw new ConflictError('This workspace uses Codex App as its controller')
    if (!agentManager) throw new Error('Agent manager is required to start agents')

    const agent = getAgent?.(workspace.id, agentId)
    const { sessionCaptureDiscriminator, sessionCaptureSnapshot, startConfig, startEnv } =
      buildAgentRunBootstrap(workspace, agentId, config, sessionStore, getCommandPreset, agent)
    const handledRunExits = new Set<string>()
    const abortedRunIds = new Set<string>()
    const startedAt = Date.now()
    const token = tokenRegistry.issue(agentId)
    const exitContext: AgentRunExitContext = {
      agentId,
      handledRunExits,
      onAgentExit,
      registry,
      sessionCaptureDiscriminator,
      sessionStore,
      startConfig,
      store,
      token,
      tokenRegistry,
      workspace,
    }
    // Pre-trust the workspace so a CLI's first-run "Do you trust this folder?"
    // prompt never blocks startup-message injection. Each helper is a no-op
    // (and never throws) when the trust flag is already set; both leave other
    // CLIs untouched.
    const cwd = startConfig.cwd?.trim() ? startConfig.cwd : workspace.path
    const commandBrand = normalizeExecutableToken(startConfig.command)
    if (commandBrand === 'claude') {
      ensureClaudeDirectoryTrusted(cwd)
    } else if (commandBrand === 'codex') {
      ensureCodexDirectoryTrusted(cwd)
    }

    const startInput = {
      agentId,
      command: startConfig.command,
      cwd,
      env: {
        ...startEnv,
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
        NO_COLOR: undefined,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'hive',
        HIVE_PORT: hivePort,
        HIVE_AGENT_TOKEN: token,
      },
      onExit: ({ runId, exitCode }: { runId: string; exitCode: number | null }) => {
        const endedAt = Date.now()
        if (
          !handleAgentRunExit(exitContext, { exitCode, endedAt, runId }) &&
          abortedRunIds.has(runId)
        ) {
          registry.clearPendingExitCode(runId)
          return
        }
      },
    }

    let run: Awaited<ReturnType<AgentManager['startAgent']>>
    try {
      run = await agentManager.startAgent({
        ...startInput,
        args: codexTeamEnvironmentArgs(commandBrand, startConfig.args),
      })
    } catch (error) {
      tokenRegistry.revokeIfMatches(agentId, token)
      throw error
    }
    let markPostStartInputReady: () => void = () => {}
    let rejectPostStartInput!: (error: unknown) => void
    const postStartInputReady = new Promise<void>((resolve, reject) => {
      markPostStartInputReady = resolve
      rejectPostStartInput = reject
    })
    // A start request may have no startup waiter; keep the original barrier rejecting.
    void postStartInputReady.catch(() => {})
    let postStartInputReadyMarked = false
    const logStartupFailure = (error: unknown) => {
      let snapshot = run
      try {
        snapshot = agentManager.getRun(run.runId)
      } catch {
        // The original run identity remains useful if cleanup already removed the buffer.
      }
      logAgentStartupFailure(snapshot, cwd, startInput.env, error)
    }
    const failPostStartInput = (error: unknown) => {
      if (postStartInputReadyMarked) return
      postStartInputReadyMarked = true
      logStartupFailure(error)
      rejectPostStartInput(error)
    }
    const finishPostStartInput = () => {
      if (postStartInputReadyMarked) return
      const current = registry.get(run.runId)
      if (
        !current ||
        current.userStopped ||
        handledRunExits.has(run.runId) ||
        registry.hasPendingExitCode(run.runId)
      ) {
        failPostStartInput(new Error('Run exited before startup completed'))
        return
      }
      try {
        const status = agentManager.getRun(run.runId).status
        if (status !== 'starting' && status !== 'running') {
          failPostStartInput(new Error('Run is not active at startup completion'))
          return
        }
      } catch (error) {
        failPostStartInput(error)
        return
      }
      postStartInputReadyMarked = true
      current.startupReadyAt = Date.now()
      markPostStartInputReady()
    }

    const liveRun: LiveAgentRun = {
      ...run,
      exitCode: run.status === 'error' ? run.exitCode : null,
      postStartInputReady,
      startedAt,
      startupReadyAt: null,
      status: run.status === 'error' ? 'error' : 'starting',
    }
    try {
      store.insertAgentRun(run.runId, agentId, startedAt, run.pid, liveRun.status, liveRun.exitCode)
    } catch (error) {
      logStartupFailure(error)
      abortedRunIds.add(run.runId)
      registry.clearPendingExitCode(run.runId)
      tokenRegistry.revokeIfMatches(agentId, token)
      agentManager.stopRun(run.runId)
      throw error
    }
    registry.createExitEntry(run.runId)
    registry.add(liveRun)
    void registry.getExitEntry(run.runId)?.promise.then(() => {
      failPostStartInput(new Error('Run exited before startup completed'))
    })

    if (run.status === 'error') {
      liveRun.status = classifyCompletedRunStatus(run.exitCode)
      store.updatePersistedRun(run.runId, liveRun.status, run.exitCode, Date.now())
      clearResumedSessionAfterExitIfStale({
        agentId,
        exitCode: run.exitCode,
        sessionCaptureDiscriminator,
        sessionStore,
        startConfig,
        workspace,
      })
      tokenRegistry.revokeIfMatches(agentId, token)
      // Ensure §12 three-state: failed spawn must flip AgentSummary to stopped.
      onAgentExit(workspace.id, agentId)
      registry.resolveExit(run.runId)
      registry.clearPendingExitCode(run.runId)
      failPostStartInput(new Error('Agent failed to start'))
      return liveRun
    }

    startAgentRunCapture({
      agentId,
      getRunOutput: () => {
        try {
          return agentManager.getRun(run.runId).output
        } catch {
          return null
        }
      },
      sessionCaptureSnapshot,
      sessionStore,
      startConfig,
      workspace,
    })
    const postStartWriter = createPostStartInputWriter(
      agentManager,
      startConfig.interactiveCommand ?? startConfig.command
    )
    queueMicrotask(() => {
      try {
        let restartWrite: Promise<void> | null = null
        const injectedRestartMessage = restartPolicy.injectPostStartMessage({
          agentId,
          runId: run.runId,
          startConfig,
          workspace,
          writeToRun: (targetRunId, text) => {
            restartWrite = postStartWriter(targetRunId, text)
            return restartWrite
          },
        })
        if (injectedRestartMessage) {
          void (restartWrite ?? Promise.resolve()).then(finishPostStartInput, failPostStartInput)
          return
        }
        if (isResumeLaunchConfig(startConfig)) {
          void waitForPostStartInputReady(
            agentManager,
            run.runId,
            startConfig.interactiveCommand ?? startConfig.command
          ).then(finishPostStartInput, failPostStartInput)
          return
        }
        if (
          agent &&
          isInteractiveAgentCommand(startConfig.interactiveCommand ?? startConfig.command)
        ) {
          if (agent.spawnedBy === 'workflow') {
            void postStartWriter(
              run.runId,
              buildWorkflowAgentStartupInstructions({
                agent,
                workspace,
              })
            ).then(finishPostStartInput, failPostStartInput)
            return
          }
          const memoryDigest = buildMemoryDigestSafely({
            contextType: 'startup',
            memoryInjection,
            workspaceId: workspace.id,
          })
          const injectionIds = logMemoryDigestInjection({
            agentId,
            contextType: 'startup',
            memoryDigest,
            memoryInjection,
            workspaceId: workspace.id,
          })
          const auditedMemoryDigest = injectionIds ? memoryDigest : null
          const failStartupInjection = (error: unknown) => {
            rollbackMemoryDigestInjection({ injectionIds, memoryInjection })
            failPostStartInput(error)
          }
          try {
            void postStartWriter(
              run.runId,
              buildAgentStartupInstructions({
                agent,
                memoryDigest: auditedMemoryDigest?.text,
                workspace,
                flags: getFlags?.() ?? FEATURE_FLAGS_ALL_OFF,
              })
            ).then(finishPostStartInput, failStartupInjection)
          } catch (error) {
            failStartupInjection(error)
          }
          return
        }
        finishPostStartInput()
      } catch (error) {
        failPostStartInput(error)
      }
    })

    if (registry.hasPendingExitCode(run.runId)) {
      const exitCode = registry.getPendingExitCode(run.runId) ?? null
      queueMicrotask(() => {
        handleAgentRunExit(exitContext, { exitCode, endedAt: Date.now(), runId: run.runId })
      })
    }

    return liveRun
  }
