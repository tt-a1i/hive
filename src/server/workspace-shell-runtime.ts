import { basename } from 'node:path'
import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { escapeCmdToken } from './windows-command-line.js'

const WORKSPACE_SHELL_SUFFIX = ':shell'
const WORKSPACE_SHELL_LABEL = 'Shell'
const EXITED_SHELL_RETENTION_MS = 5000

export const getWorkspaceShellAgentId = (workspaceId: string): string =>
  `${workspaceId}${WORKSPACE_SHELL_SUFFIX}`

export const isWorkspaceShellAgentId = (agentId: string): boolean =>
  agentId.endsWith(WORKSPACE_SHELL_SUFFIX)

const shouldUseLoginShell = (command: string) => {
  const name = basename(command).toLowerCase()
  return name === 'bash' || name === 'fish' || name === 'ksh' || name === 'zsh'
}

const getEnvValue = (
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform
): string | undefined => {
  if (platform !== 'win32') return env[key]
  const matched = Object.keys(env).find((item) => item.toLowerCase() === key.toLowerCase())
  return matched ? env[matched] : undefined
}

export const resolveWorkspaceShellLaunch = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): { args: string[]; command: string } => {
  if (platform === 'win32')
    return { command: getEnvValue(env, 'ComSpec', platform) ?? 'cmd.exe', args: [] }
  const command = env.SHELL || '/bin/sh'
  return { command, args: shouldUseLoginShell(command) ? ['-l'] : [] }
}

const isWindowsUncPath = (path: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' && /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/u.test(path)

const getWindowsSafeShellCwd = (env: NodeJS.ProcessEnv = process.env): string => {
  const systemRoot = getEnvValue(env, 'SystemRoot', 'win32')
  if (systemRoot) return systemRoot
  const systemDrive = getEnvValue(env, 'SystemDrive', 'win32')
  if (systemDrive) return `${systemDrive}\\`
  return process.cwd()
}

export const resolveWorkspaceShellStart = (
  workspacePath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): { args: string[]; command: string; cwd: string } => {
  const launch = resolveWorkspaceShellLaunch(env, platform)
  if (isWindowsUncPath(workspacePath, platform)) {
    return {
      args: ['/d', '/s', '/k', `pushd ${escapeCmdToken(workspacePath)}`],
      command: launch.command,
      cwd: getWindowsSafeShellCwd(env),
    }
  }
  return { ...launch, cwd: workspacePath }
}

export const createWorkspaceShellRuntime = (agentManager: AgentManager | undefined) => {
  const labelsByRunId = new Map<string, string>()
  const workspaceIdsByRunId = new Map<string, string>()
  const runIdsByWorkspaceId = new Map<string, string[]>()
  const startedAtByRunId = new Map<string, number>()
  const exitCleanupTimersByRunId = new Map<string, ReturnType<typeof setTimeout>>()
  // Keep exit promises after a shell is detached from the UI, until its PTY exits.
  const pendingExits = new Set<Promise<void>>()
  let closing = false

  const requireManager = () => {
    if (!agentManager) throw new Error('Agent manager is required for workspace shell terminals')
    return agentManager
  }

  const hasRun = (runId: string) => workspaceIdsByRunId.has(runId)

  const toLiveRun = (runId: string): LiveAgentRun => {
    try {
      return {
        ...requireManager().getRun(runId),
        startedAt: startedAtByRunId.get(runId) ?? Date.now(),
      }
    } catch (error) {
      detachRun(runId)
      throw error
    }
  }

  const detachRun = (runId: string) => {
    const exitCleanupTimer = exitCleanupTimersByRunId.get(runId)
    if (exitCleanupTimer) clearTimeout(exitCleanupTimer)
    exitCleanupTimersByRunId.delete(runId)
    const workspaceId = workspaceIdsByRunId.get(runId)
    if (workspaceId) {
      const retained = (runIdsByWorkspaceId.get(workspaceId) ?? []).filter((id) => id !== runId)
      if (retained.length > 0) runIdsByWorkspaceId.set(workspaceId, retained)
      else runIdsByWorkspaceId.delete(workspaceId)
    }
    labelsByRunId.delete(runId)
    workspaceIdsByRunId.delete(runId)
    startedAtByRunId.delete(runId)
  }

  const attachRun = (workspaceId: string, runId: string, label: string, startedAt: number) => {
    labelsByRunId.set(runId, label)
    workspaceIdsByRunId.set(runId, workspaceId)
    startedAtByRunId.set(runId, startedAt)
    runIdsByWorkspaceId.set(workspaceId, [...(runIdsByWorkspaceId.get(workspaceId) ?? []), runId])
  }

  const forgetShellRun = (runId: string) => {
    detachRun(runId)
    try {
      requireManager().removeRun(runId)
    } catch {
      // The PTY manager may have already dropped the run.
    }
  }

  const handleShellExit = (runId: string) => {
    if (!hasRun(runId) || exitCleanupTimersByRunId.has(runId)) return
    const timer = setTimeout(() => {
      exitCleanupTimersByRunId.delete(runId)
      if (hasRun(runId)) forgetShellRun(runId)
    }, EXITED_SHELL_RETENTION_MS)
    timer.unref?.()
    exitCleanupTimersByRunId.set(runId, timer)
  }

  const isListedRun = (run: LiveAgentRun) => run.status === 'starting' || run.status === 'running'

  const stopPtyRun = (runId: string) => {
    requireManager().stopRun(runId)
  }

  const closeRun = (runId: string) => {
    stopPtyRun(runId)
    requireManager().removeRun(runId)
    detachRun(runId)
  }

  const closeRuns = (runIds: string[]) => {
    const errors: unknown[] = []
    for (const runId of runIds) {
      try {
        closeRun(runId)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to stop workspace shells')
  }

  return {
    async close() {
      closing = true
      closeRuns(Array.from(workspaceIdsByRunId.keys()))
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.all(pendingExits),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Workspace shell shutdown timed out')),
              5000
            )
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      runIdsByWorkspaceId.clear()
      workspaceIdsByRunId.clear()
      startedAtByRunId.clear()
      labelsByRunId.clear()
      for (const timer of exitCleanupTimersByRunId.values()) clearTimeout(timer)
      exitCleanupTimersByRunId.clear()
    },
    closeRun(workspaceId: string, runId: string): boolean {
      if (workspaceIdsByRunId.get(runId) !== workspaceId) return false
      closeRun(runId)
      return true
    },
    deleteWorkspace(workspaceId: string) {
      closeRuns(Array.from(runIdsByWorkspaceId.get(workspaceId) ?? []))
      runIdsByWorkspaceId.delete(workspaceId)
    },
    getLiveRun(runId: string): LiveAgentRun | undefined {
      if (!hasRun(runId)) return undefined
      return toLiveRun(runId)
    },
    hasRun,
    listTerminalRuns(workspaceId: string) {
      return (runIdsByWorkspaceId.get(workspaceId) ?? []).flatMap((runId) => {
        try {
          const run = toLiveRun(runId)
          if (!isListedRun(run)) return []
          return [
            {
              agent_id: getWorkspaceShellAgentId(workspaceId),
              agent_name: labelsByRunId.get(runId) ?? 'Shell',
              run_id: run.runId,
              status: run.status,
              terminal_input_profile: 'default' as const,
            },
          ]
        } catch {
          return []
        }
      })
    },
    pauseRun(runId: string) {
      if (hasRun(runId)) requireManager().pauseRun(runId)
    },
    resizeRun(runId: string, cols: number, rows: number) {
      if (hasRun(runId)) requireManager().resizeRun(runId, cols, rows)
    },
    resumeRun(runId: string) {
      if (hasRun(runId)) requireManager().resumeRun(runId)
    },
    async start(workspace: WorkspaceSummary): Promise<LiveAgentRun> {
      if (closing) throw new Error('Workspace shell runtime is closing')
      const startedAt = Date.now()
      const launch = resolveWorkspaceShellStart(workspace.path)
      let resolveExit!: () => void
      const exit = new Promise<void>((resolve) => {
        resolveExit = resolve
      })
      pendingExits.add(exit)
      void exit.then(() => pendingExits.delete(exit))
      let run: Awaited<ReturnType<AgentManager['startAgent']>>
      try {
        run = await requireManager().startAgent({
          agentId: getWorkspaceShellAgentId(workspace.id),
          args: launch.args,
          command: launch.command,
          cwd: launch.cwd,
          env: {
            COLORTERM: 'truecolor',
            FORCE_COLOR: '1',
            NO_COLOR: undefined,
            TERM: 'xterm-256color',
            TERM_PROGRAM: 'hive-shell',
          },
          onExit: ({ runId }) => {
            resolveExit()
            handleShellExit(runId)
          },
        })
      } catch (error) {
        resolveExit()
        throw error
      }
      // Retain ownership even if stopping an in-flight start throws, so callers
      // can explicitly retry rather than losing the live process from the runtime.
      attachRun(workspace.id, run.runId, WORKSPACE_SHELL_LABEL, startedAt)
      if (closing) {
        stopPtyRun(run.runId)
        await exit
        requireManager().removeRun(run.runId)
        detachRun(run.runId)
        throw new Error('Workspace shell runtime is closing')
      }
      return { ...run, startedAt }
    },
    stopRun(runId: string) {
      if (hasRun(runId)) stopPtyRun(runId)
    },
    writeInput(runId: string, input: Buffer | string) {
      if (hasRun(runId)) requireManager().writeInput(runId, input)
    },
  }
}

export type WorkspaceShellRuntime = ReturnType<typeof createWorkspaceShellRuntime>
