import { randomUUID } from 'node:crypto'
import type { IWindowsPtyForkOptions } from '@lydell/node-pty'
import { resolveSpawnCommand } from './agent-command-resolver.js'
import { attachAgentPty, toAgentRunSnapshot } from './agent-manager-support.js'
import { logAgentStartupFailure } from './agent-startup-diagnostics.js'
import { spawn } from './pty.js'
import { createPtyOutputBus, type PtyOutputBus } from './pty-output-bus.js'

type RunStatus = 'starting' | 'running' | 'exited' | 'error'

interface StartAgentInput {
  agentId: string
  command: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface AgentRunSnapshot {
  runId: string
  agentId: string
  pid: number | null
  status: RunStatus
  output: string
  exitCode: number | null
}

interface AgentRunRecord extends AgentRunSnapshot {
  process: {
    isStopped: () => boolean
    pause: () => void
    pid: number | null
    resize: (cols: number, rows: number) => void
    resume: () => void
    stop: () => void
    write: (input: Buffer | string) => void
  }
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface AgentManager {
  getOutputBus: () => PtyOutputBus
  pauseRun: (runId: string) => void
  resizeRun: (runId: string, cols: number, rows: number) => void
  resumeRun: (runId: string) => void
  startAgent: (input: StartAgentInput) => Promise<AgentRunSnapshot>
  writeInput: (runId: string, input: Buffer | string) => void
  getRun: (runId: string) => AgentRunSnapshot
  removeRun: (runId: string) => void
  stopRun: (runId: string) => void
}

const createRunId = () => randomUUID()

const CLAUDE_AGENT_SESSION_ENV_KEYS = new Set([
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_EFFORT',
])

const isClaudeAgentSessionEnvKey = (key: string, platform: NodeJS.Platform) =>
  CLAUDE_AGENT_SESSION_ENV_KEYS.has(platform === 'win32' ? key.toUpperCase() : key)

const getWindowsEnvKey = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  if (Object.hasOwn(env, key)) return key
  return Object.keys(env)
    .filter((item) => item.toLowerCase() === key.toLowerCase())
    .at(-1)
}

export const createSpawnEnv = (
  inputEnv?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env = { ...parentEnv }
  for (const [key, value] of Object.entries(inputEnv ?? {})) {
    const targetKey = platform === 'win32' ? (getWindowsEnvKey(env, key) ?? key) : key
    env[targetKey] = value
  }
  for (const key of Object.keys(env)) {
    // Final spawn boundary: strip outer Claude session identity, not Claude runtime config.
    if (env[key] === undefined || isClaudeAgentSessionEnvKey(key, platform)) delete env[key]
  }
  return env
}

export const buildAgentPtySpawnOptions = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): IWindowsPtyForkOptions => ({
  cols: 80,
  cwd,
  env,
  name: 'xterm-256color',
  rows: 24,
  ...(platform === 'win32' ? { useConpty: true } : {}),
})

export const createAgentManager = ({
  ptyOutputBus = createPtyOutputBus(),
}: {
  ptyOutputBus?: PtyOutputBus
} = {}): AgentManager => {
  const runs = new Map<string, AgentRunRecord>()

  const getRunRecord = (runId: string) => {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    return run
  }

  return {
    getOutputBus() {
      return ptyOutputBus
    },
    pauseRun(runId) {
      getRunRecord(runId).process.pause()
    },
    async startAgent(input) {
      const env = createSpawnEnv(input.env)
      const runId = createRunId()

      const run: AgentRunRecord = {
        runId,
        agentId: input.agentId,
        pid: null,
        status: 'starting',
        output: '',
        exitCode: null,
        process: {
          isStopped() {
            return false
          },
          pause() {},
          pid: null,
          resize() {},
          resume() {},
          stop() {},
          write() {},
        },
      }

      if (input.onExit) run.onExit = input.onExit

      runs.set(runId, run)

      try {
        const spawnCommand = resolveSpawnCommand(input.command, input.cwd, env, input.args ?? [])
        attachAgentPty(
          run,
          spawn(spawnCommand.command, spawnCommand.args, buildAgentPtySpawnOptions(input.cwd, env)),
          ptyOutputBus
        )
      } catch (error) {
        logAgentStartupFailure(run, input.cwd, env, error)
        runs.delete(runId)
        throw error
      }

      return toAgentRunSnapshot(run)
    },

    resizeRun(runId, cols, rows) {
      getRunRecord(runId).process.resize(cols, rows)
    },

    resumeRun(runId) {
      getRunRecord(runId).process.resume()
    },

    writeInput(runId, text) {
      getRunRecord(runId).process.write(text)
    },

    getRun(runId) {
      return toAgentRunSnapshot(getRunRecord(runId))
    },

    removeRun(runId) {
      runs.delete(runId)
    },

    stopRun(runId) {
      const run = getRunRecord(runId)
      run.process.stop()
    },
  }
}

export type { AgentManager, AgentRunRecord, AgentRunSnapshot, RunStatus, StartAgentInput }
