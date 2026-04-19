import { randomUUID } from 'node:crypto'
import { type IPty, spawn } from 'node-pty'
import {
  finishAgentRun,
  MAX_RUN_OUTPUT_LENGTH,
  toAgentRunSnapshot,
} from './agent-manager-support.js'
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
    pid: number | null
    resize: (cols: number, rows: number) => void
    stop: () => void
    write: (text: string) => void
  }
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface AgentManager {
  getOutputBus: () => PtyOutputBus
  resizeRun: (runId: string, cols: number, rows: number) => void
  startAgent: (input: StartAgentInput) => Promise<AgentRunSnapshot>
  writeInput: (runId: string, text: string) => void
  getRun: (runId: string) => AgentRunSnapshot
  removeRun: (runId: string) => void
  stopRun: (runId: string) => void
}

const createRunId = () => randomUUID()

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

  const attachPty = (run: AgentRunRecord, pty: IPty) => {
    run.process = {
      isStopped() {
        return run.status === 'exited' || run.status === 'error'
      },
      pid: pty.pid,
      resize(cols, rows) {
        pty.resize(cols, rows)
      },
      stop() {
        try {
          pty.kill()
        } catch (error) {
          // Race: PTY exited between our status check and kill(). The kernel returns ESRCH.
          // onExit will (or did) finalize run.status; treat this stop as a no-op.
          if ((error as NodeJS.ErrnoException | null)?.code === 'ESRCH') return
          throw error
        }
      },
      write(text) {
        pty.write(text)
      },
    }

    pty.onData((chunk) => {
      if (run.status === 'starting') run.status = 'running'
      run.output += chunk
      if (run.output.length > MAX_RUN_OUTPUT_LENGTH)
        run.output = run.output.slice(-MAX_RUN_OUTPUT_LENGTH)
      ptyOutputBus.publish(run.runId, chunk)
    })

    pty.onExit((event) => finishAgentRun(run, event.exitCode, ptyOutputBus))
  }

  return {
    getOutputBus() {
      return ptyOutputBus
    },
    async startAgent(input) {
      const runId = createRunId()
      const env = { ...process.env, ...input.env }

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
          pid: null,
          resize() {},
          stop() {},
          write() {},
        },
      }

      if (input.onExit) run.onExit = input.onExit

      runs.set(runId, run)

      try {
        attachPty(
          run,
          spawn(input.command, input.args ?? [], {
            cwd: input.cwd,
            env,
            name: 'xterm-color',
          })
        )
      } catch {
        run.status = 'error'
        run.exitCode = 1
      }

      return toAgentRunSnapshot(run)
    },

    resizeRun(runId, cols, rows) {
      getRunRecord(runId).process.resize(cols, rows)
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
