import { execFile, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

import type { IPty } from '@lydell/node-pty'

import { classifyCompletedRunStatus } from './agent-exit-classification.js'
import type { AgentRunRecord, AgentRunSnapshot } from './agent-manager.js'
import type { PtyOutputBus } from './pty-output-bus.js'

export const MAX_RUN_OUTPUT_LENGTH = 1_000_000
const FORCE_KILL_DELAY_MS = 750
const TASKKILL_TIMEOUT_MS = 3000
const PTY_READ_EOF_EXIT_GRACE_MS = 1000

type ExecRunner = (cmd: string, args: readonly string[], done: (success: boolean) => void) => void

type ErrorEventPty = IPty & {
  on?: (eventName: 'error', listener: (error: unknown) => void) => void
}

type ForkOptions = import('node:child_process').ForkOptions
type ForkedChildProcess = import('node:child_process').ChildProcess
type ForkCallable = (
  modulePath: string | URL,
  argsOrOptions?: readonly string[] | ForkOptions,
  options?: ForkOptions
) => ForkedChildProcess

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process') as typeof import('node:child_process')

const isConptyConsoleListAgentPath = (modulePath: string | URL): boolean => {
  const normalized = String(modulePath).replaceAll('\\', '/')
  return (
    normalized.endsWith('/conpty_console_list_agent') ||
    normalized.endsWith('/conpty_console_list_agent.js')
  )
}

export const withSilencedConptyConsoleListAgent = <T>(
  platform: NodeJS.Platform,
  action: () => T
): T => {
  if (platform !== 'win32') return action()
  const originalFork = childProcess.fork as ForkCallable
  const patchedFork: ForkCallable = (modulePath, argsOrOptions, options) => {
    if (!isConptyConsoleListAgentPath(modulePath)) {
      return Array.isArray(argsOrOptions)
        ? originalFork.call(childProcess, modulePath, argsOrOptions, options)
        : originalFork.call(childProcess, modulePath, argsOrOptions)
    }
    const forkOptions = Array.isArray(argsOrOptions) ? options : argsOrOptions
    const silentOptions = { ...(forkOptions ?? {}), silent: true }
    const child = Array.isArray(argsOrOptions)
      ? originalFork.call(childProcess, modulePath, argsOrOptions, silentOptions)
      : originalFork.call(childProcess, modulePath, silentOptions)
    child.stderr?.resume()
    child.stdout?.resume()
    return child
  }
  childProcess.fork = patchedFork as typeof childProcess.fork
  try {
    return action()
  } finally {
    childProcess.fork = originalFork as typeof childProcess.fork
  }
}

const isPtyReadEofError = (
  error: unknown,
  platform: NodeJS.Platform = process.platform
): boolean => {
  const candidate = error as NodeJS.ErrnoException | null
  return platform !== 'win32' && candidate?.code === 'EIO' && candidate.syscall === 'read'
}

const serializePtyInput = (input: Buffer | string): string =>
  Buffer.isBuffer(input) ? input.toString('latin1') : input

const defaultExecRunner: ExecRunner = (cmd, args, done) => {
  let settled = false
  const settle = (success: boolean) => {
    if (settled) return
    settled = true
    done(success)
  }
  const child = execFile(
    cmd,
    [...args],
    { maxBuffer: 64 * 1024, timeout: TASKKILL_TIMEOUT_MS, windowsHide: true },
    (error) => settle(!error)
  )
  child.once('error', () => settle(false))
}

/**
 * Windows analogue of POSIX `process.kill(-pgid, SIGKILL)`. node-pty on
 * Windows hands `pty.kill()` to TerminateProcess against the PTY's main
 * process only — children that the worker spawned (npm install, build
 * scripts, custom tooling) become orphans and keep writing to the
 * filesystem after the worker card flips to stopped.
 *
 * `taskkill /pid <pid> /t /f` walks the process tree (`/t`) and forces
 * termination (`/f`), matching what task manager would do.
 *
 * IMPORTANT — call this BEFORE any other termination of the parent
 * process. taskkill /T builds the tree by querying the parent for its
 * descendants; if the parent is already gone (e.g. pty.kill() ran
 * first) the enumeration returns empty and the children become
 * orphans. /F also terminates the parent itself, so a parent-kill
 * after this call is only useful as a fallback when taskkill itself
 * failed (taskkill missing from PATH, restricted PowerShell, etc.).
 *
 * Best-effort: non-zero exits (process already gone, taskkill missing
 * from PATH, access denied) are swallowed and surface as a `false`
 * return. The caller is expected to fall back to pty.kill().
 *
 * Exported for unit testing — the `runner` parameter lets tests assert
 * the exact argv without mocking node:child_process.
 */
export const taskkillProcessTree = (
  pid: number,
  platform: NodeJS.Platform = process.platform,
  runner: ExecRunner = defaultExecRunner,
  onFailure?: () => void
): boolean => {
  if (platform !== 'win32' || pid <= 0) return false
  try {
    runner('taskkill', ['/pid', String(pid), '/t', '/f'], (success) => {
      if (!success) onFailure?.()
    })
    return true
  } catch {
    return false
  }
}

export const toAgentRunSnapshot = (run: AgentRunRecord): AgentRunSnapshot => ({
  runId: run.runId,
  agentId: run.agentId,
  pid: run.process.pid,
  status:
    run.process.isStopped() && run.status !== 'exited' && run.status !== 'error'
      ? 'error'
      : run.status,
  output: run.output,
  exitCode: run.exitCode,
})

export const finishAgentRun = (
  run: AgentRunRecord,
  exitCode: number | null,
  ptyOutputBus: PtyOutputBus
) => {
  if (run.status === 'exited' || run.status === 'error') return
  run.status = classifyCompletedRunStatus(exitCode)
  run.exitCode = exitCode
  try {
    run.onExit?.({ runId: run.runId, exitCode })
  } finally {
    ptyOutputBus.clear(run.runId)
  }
}

export const attachAgentPty = (
  run: AgentRunRecord,
  pty: IPty,
  ptyOutputBus: PtyOutputBus,
  platform: NodeJS.Platform = process.platform,
  execRunner: ExecRunner = defaultExecRunner
) => {
  let stdinClosed = false
  let stopRequested = false
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  let ptyReadEofTimer: ReturnType<typeof setTimeout> | undefined
  const resolveProcessGroupId = () => {
    if (platform === 'win32' || pty.pid <= 0) return null
    try {
      const value = execFileSync('ps', ['-o', 'pgid=', '-p', String(pty.pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      const groupId = Number(value)
      if (Number.isInteger(groupId) && groupId > 0) return groupId
    } catch {
      return pty.pid
    }
    return pty.pid
  }
  let processGroupId: number | null | undefined
  const getProcessGroupId = () => {
    if (processGroupId !== undefined) return processGroupId
    processGroupId = resolveProcessGroupId()
    return processGroupId
  }
  const stopped = () => run.status === 'exited' || run.status === 'error'
  const ignoreMissingProcess = (error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ESRCH') throw error
  }
  const ignoreBestEffortGroupKillError = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
  const killProcessGroup = (signal: NodeJS.Signals) => {
    const groupId = getProcessGroupId()
    if (platform === 'win32' || groupId === null) return
    try {
      process.kill(-groupId, signal)
    } catch (error) {
      ignoreBestEffortGroupKillError(error)
    }
  }
  const killPtyDirect = (signal?: NodeJS.Signals) => {
    try {
      if (platform === 'win32') withSilencedConptyConsoleListAgent(platform, () => pty.kill())
      else pty.kill(signal)
    } catch (error) {
      ignoreMissingProcess(error)
    }
  }
  const killPty = (signal: NodeJS.Signals) => {
    if (platform === 'win32') {
      // taskkill /pid <pid> /t /f walks the parent's process tree
      // BEFORE terminating it — so we have to run it while the parent
      // is still alive. Calling pty.kill() first (the previous
      // ordering) detaches the children: taskkill /T then fails with
      // "process not found" and the npm-installs / build scripts
      // become orphans. taskkill /f also terminates the parent, so
      // pty.kill() is the fallback for the rare case where taskkill
      // is missing from PATH or refused (e.g. restricted PowerShell).
      if (!taskkillProcessTree(pty.pid, platform, execRunner, () => killPtyDirect()))
        killPtyDirect()
    } else killPtyDirect(signal)
    killProcessGroup(signal)
  }
  const clearForceKillTimer = () => {
    if (!forceKillTimer) return
    clearTimeout(forceKillTimer)
    forceKillTimer = undefined
  }
  const clearPtyReadEofTimer = () => {
    if (!ptyReadEofTimer) return
    clearTimeout(ptyReadEofTimer)
    ptyReadEofTimer = undefined
  }
  const schedulePtyReadEofExitGuard = (error: unknown) => {
    if (ptyReadEofTimer) return
    ptyReadEofTimer = setTimeout(() => {
      ptyReadEofTimer = undefined
      if (stopped()) return
      console.error(`[hive] PTY read EOF without exit for run ${run.runId}`, error)
      finishAgentRun(run, null, ptyOutputBus)
      try {
        killPty('SIGTERM')
        scheduleForceKill()
      } catch (killError) {
        ignoreMissingProcess(killError)
      }
    }, PTY_READ_EOF_EXIT_GRACE_MS)
    ptyReadEofTimer.unref?.()
  }
  const cleanupProcessGroup = () => {
    clearForceKillTimer()
    clearPtyReadEofTimer()
    killProcessGroup('SIGKILL')
  }
  const scheduleForceKill = () => {
    if (forceKillTimer) return
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined
      try {
        if (platform === 'win32') {
          // Same ordering as killPty(): tree-kill before terminating the
          // parent, so taskkill /T can still enumerate the process tree.
          // pty.kill() is the cleanup fallback for taskkill-missing hosts;
          // its noisy dependency helper is silenced in killPtyDirect().
          if (!taskkillProcessTree(pty.pid, platform, execRunner, () => killPtyDirect()))
            killPtyDirect()
        } else killPtyDirect('SIGKILL')
      } catch (error) {
        ignoreMissingProcess(error)
      }
      killProcessGroup('SIGKILL')
    }, FORCE_KILL_DELAY_MS)
    forceKillTimer.unref?.()
  }
  pty.onExit((event) => {
    stdinClosed = true
    clearPtyReadEofTimer()
    cleanupProcessGroup()
    finishAgentRun(run, event.exitCode, ptyOutputBus)
  })
  run.process = {
    isStopped() {
      return stopped()
    },
    pause() {
      pty.pause()
    },
    pid: pty.pid,
    resize(cols, rows) {
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
        throw new Error(`Invalid terminal size for run: ${run.runId}`)
      }
      pty.resize(cols, rows)
    },
    resume() {
      pty.resume()
    },
    stop() {
      if (stopped()) {
        cleanupProcessGroup()
        return
      }
      // Workspace deletion and runtime shutdown can overlap before onExit.
      // Start termination once; the existing timer owns any escalation.
      if (stopRequested) return
      stopRequested = true
      clearPtyReadEofTimer()
      try {
        killPty('SIGTERM')
      } catch (error) {
        // A failed termination attempt must not suppress an explicit retry.
        stopRequested = false
        throw error
      }
      stdinClosed = true
      scheduleForceKill()
    },
    write(text) {
      if (stdinClosed || run.status === 'exited' || run.status === 'error') {
        throw new Error(`PTY is not active for run: ${run.runId}`)
      }
      pty.write(serializePtyInput(text))
    },
  }

  pty.onData((chunk) => {
    if (run.status === 'starting') run.status = 'running'
    run.output += chunk
    if (run.output.length > MAX_RUN_OUTPUT_LENGTH)
      run.output = run.output.slice(-MAX_RUN_OUTPUT_LENGTH)
    ptyOutputBus.publish(run.runId, chunk)
  })

  ;(pty as ErrorEventPty).on?.('error', (error) => {
    if (stopped()) return
    if (isPtyReadEofError(error, platform)) {
      // Unix PTYs can surface a closed slave as read/EIO just before
      // node-pty delivers the real onExit event. Treat it as EOF, not
      // as the run's terminal status.
      stdinClosed = true
      schedulePtyReadEofExitGuard(error)
      return
    }
    console.error(`[hive] PTY error for run ${run.runId}`, error)
    stdinClosed = true
    finishAgentRun(run, null, ptyOutputBus)
    try {
      killPty('SIGTERM')
    } catch (killError) {
      ignoreMissingProcess(killError)
    }
  })
}
