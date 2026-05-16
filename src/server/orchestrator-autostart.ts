import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { getStartupCommandExecutable } from './startup-command-parser.js'

interface AutostartPort {
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: { hivePort: string }
  ) => Promise<{ runId: string; status: string; exitCode: number | null }>
  getLiveRun: (runId: string) => { status: string; exitCode: number | null }
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
}

// SETTLE_WAIT_MS: how long we wait before declaring autostart "ok". Must be
// long enough to observe an early exit when the child shell prints
// "command not found" then dies with exit 127 (typically <100ms in practice).
// 800ms balances reliability vs the perceived workspace-create latency cost.
const SETTLE_WAIT_MS = 800
const POLL_INTERVAL_MS = 25

// Shells emit exit code 127 when the requested command is not on PATH (POSIX).
// node-pty does NOT raise a synchronous spawn error for that case — the PTY
// just dies almost immediately via onExit. We translate that to the same UX
// string as the sync-ENOENT path so the user gets one consistent message.
const COMMAND_NOT_FOUND_EXIT_CODE = 127

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface OrchestratorStartResult {
  ok: boolean
  error: string | null
  run_id: string | null
}

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'

/**
 * Format a friendly error message that surfaces the actual binary name when
 * spawn fails with ENOENT (e.g. `claude CLI not found in PATH`).
 */
const formatStartError = (error: unknown, command: string | undefined): string => {
  if (isErrnoException(error) && error.code === 'ENOENT' && command) {
    return `${command} CLI not found in PATH`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Translate an early-exit terminal state to a human-friendly error string.
 *
 * Two cases land here:
 *   - exit 127: shell saying "command not found" (the most common real case
 *     when the configured CLI is missing — node-pty does NOT throw sync ENOENT
 *     for missing binaries, it spawns successfully and the child dies via
 *     onExit).
 *   - any other non-zero exit: surface the raw code so we don't lie about the
 *     cause.
 */
const formatEarlyExitError = (command: string, exitCode: number | null): string => {
  if (exitCode === COMMAND_NOT_FOUND_EXIT_CODE) {
    return `${command} CLI not found in PATH`
  }
  return `${command} failed to start (exit ${exitCode ?? 'null'})`
}

const getLaunchErrorCommand = (config: AgentLaunchConfigInput): string => {
  if (config.presetAugmentationDisabled) {
    const startupCommand = config.args?.at(-1)
    const executable = startupCommand ? getStartupCommandExecutable(startupCommand) : null
    if (executable) return executable
  }
  return config.interactiveCommand ?? config.command
}

/**
 * Wraps `store.startAgent` so spawn failures never bubble up: callers always
 * receive a structured result. The HTTP layer uses this to keep workspace
 * creation green even when the orchestrator binary is missing.
 */
export const autostartOrchestrator = async (
  port: AutostartPort,
  workspaceId: string,
  orchestratorId: string,
  hivePort: string
): Promise<OrchestratorStartResult> => {
  return autostartAgent(port, workspaceId, orchestratorId, hivePort, {
    missingConfigError:
      'No orchestrator launch config available (set HIVE_ORCHESTRATOR_COMMAND or seed a role template)',
  })
}

export const autostartAgent = async (
  port: AutostartPort,
  workspaceId: string,
  agentId: string,
  hivePort: string,
  options: { missingConfigError: string }
): Promise<OrchestratorStartResult> => {
  const config = port.peekAgentLaunchConfig(workspaceId, agentId)
  if (!config) {
    return {
      ok: false,
      error: options.missingConfigError,
      run_id: null,
    }
  }
  try {
    const run = await port.startAgent(workspaceId, agentId, { hivePort })
    // node-pty often doesn't throw on missing binaries — it spawns then exits
    // fast via onExit with a non-zero code. Poll briefly so we surface the
    // failure synchronously in the response instead of returning a fake "ok".
    //
    // Loop condition is "until we hit a terminal state OR deadline". Earlier
    // versions exited as soon as `status === 'running'`, which missed the case
    // where bash prints `command not found` (status flips to running) and then
    // exits 127 a few ms later. The tighter loop catches that path.
    let exitCode: number | null = run.exitCode
    let status: string = run.status
    const deadline = Date.now() + SETTLE_WAIT_MS
    while (status !== 'exited' && status !== 'error' && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      try {
        const live = port.getLiveRun(run.runId)
        status = live.status
        exitCode = live.exitCode
      } catch {
        break
      }
    }
    if (status === 'error' || (status === 'exited' && (exitCode ?? 0) !== 0)) {
      return {
        ok: false,
        error: formatEarlyExitError(getLaunchErrorCommand(config), exitCode),
        run_id: run.runId,
      }
    }
    return { ok: true, error: null, run_id: run.runId }
  } catch (error) {
    return {
      ok: false,
      error: formatStartError(error, getLaunchErrorCommand(config)),
      run_id: null,
    }
  }
}
