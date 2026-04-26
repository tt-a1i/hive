import { randomUUID } from 'node:crypto'
import { spawn } from 'node-pty'
import { assertCommandIsExecutable } from './agent-command-resolver.js'
import { attachAgentPty, toAgentRunSnapshot } from './agent-manager-support.js'
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
    write: (text: string) => void
  }
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface AgentManager {
  getOutputBus: () => PtyOutputBus
  pauseRun: (runId: string) => void
  resizeRun: (runId: string, cols: number, rows: number) => void
  resumeRun: (runId: string) => void
  startAgent: (input: StartAgentInput) => Promise<AgentRunSnapshot>
  writeInput: (runId: string, text: string) => void
  getRun: (runId: string) => AgentRunSnapshot
  removeRun: (runId: string) => void
  stopRun: (runId: string) => void
}

const createRunId = () => randomUUID()

const createSpawnEnv = (inputEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...inputEnv }
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key]
  }
  return env
}

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
      assertCommandIsExecutable(input.command, input.cwd, env)

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
        attachAgentPty(
          run,
          spawn(input.command, input.args ?? [], {
            cwd: input.cwd,
            env,
            name: 'xterm-256color',
          }),
          ptyOutputBus
        )
      } catch (error) {
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
      if (run.status === 'exited' || run.status === 'error') return
      run.process.stop()
    },
  }
}

export type { AgentManager, AgentRunRecord, AgentRunSnapshot, RunStatus, StartAgentInput }
