import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { getStartupCommandExecutable } from './startup-command-parser.js'

interface AutostartPort {
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: { hivePort: string }
  ) => Promise<{ runId: string; status: string; exitCode: number | null }>
  getLiveRun: (runId: string) => { status: string; exitCode: number | null; output?: string }
  waitForRunExit?: (runId: string, timeoutMs: number) => Promise<boolean>
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
}

// SETTLE_WAIT_MS: how long we wait before declaring autostart "ok". Must be
// long enough to observe an early exit when the child shell prints
// "command not found" then dies with exit 127 (POSIX) or 9009 (Windows)
// - typically <100ms in practice. 800ms balances reliability vs the perceived
// workspace-create latency cost. Production runtime exposes an exit promise so
// we don't miss the event between polling ticks; stubs fall back to polling.
const SETTLE_WAIT_MS = process.platform === 'win32' ? 2000 : 800
// node-pty's spawn helper can take several seconds to finish executing a
// shebang script that exits immediately. Only use this longer window while the
// PTY is still completely silent and "starting"; real CLIs that print output
// keep the normal fast path above.
const SILENT_STARTING_SETTLE_WAIT_MS = process.platform === 'win32' ? 5000 : 4000
const POLL_INTERVAL_MS = 25

// Shells emit a "command not found" exit code when the requested binary is
// missing on PATH. node-pty does NOT raise a synchronous spawn error for that
// case — the PTY just dies almost immediately via onExit. We translate that to
// the same UX string as the sync-ENOENT path so the user gets one consistent
// message. POSIX shells use 127; Windows cmd.exe uses 9009.
const COMMAND_NOT_FOUND_EXIT_CODES: ReadonlySet<number> = new Set([127, 9009])

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
 *   - exit 127 (POSIX) / 9009 (Windows cmd.exe): shell saying "command not
 *     found" — the most common real case when the configured CLI is missing,
 *     because node-pty does NOT throw sync ENOENT for missing binaries; it
 *     spawns successfully and the child dies via onExit.
 *   - any other non-zero exit: surface the raw code so we don't lie about the
 *     cause.
 */
export const formatEarlyExitError = (command: string, exitCode: number | null): string => {
  if (exitCode !== null && COMMAND_NOT_FOUND_EXIT_CODES.has(exitCode)) {
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
    // fast via onExit with a non-zero code. Wait briefly for that real exit
    // event so we surface the failure synchronously instead of returning a fake
    // "ok". Older test ports without waitForRunExit use the polling fallback.
    let exitCode: number | null = run.exitCode
    let status: string = run.status
    let output = ''
    const startedAt = performance.now()
    let deadline = startedAt + SETTLE_WAIT_MS
    const silentStartingDeadline = startedAt + SILENT_STARTING_SETTLE_WAIT_MS
    while (status !== 'exited' && status !== 'error' && performance.now() < deadline) {
      const remainingMs = Math.max(0, deadline - performance.now())
      const waitMs = Math.min(POLL_INTERVAL_MS, remainingMs)
      if (port.waitForRunExit) {
        await port.waitForRunExit(run.runId, waitMs)
      } else {
        await sleep(waitMs)
      }
      try {
        const live = port.getLiveRun(run.runId)
        status = live.status
        exitCode = live.exitCode
        output = live.output ?? output
      } catch {
        break
      }
      if (
        status === 'starting' &&
        output.length === 0 &&
        deadline < silentStartingDeadline &&
        performance.now() >= deadline
      ) {
        deadline = silentStartingDeadline
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
