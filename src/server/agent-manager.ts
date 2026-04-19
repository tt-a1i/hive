import { randomUUID } from 'node:crypto'
import { type IPty, spawn } from 'node-pty'

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
    stop: () => void
    write: (text: string) => void
  }
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface AgentManager {
  startAgent: (input: StartAgentInput) => Promise<AgentRunSnapshot>
  writeInput: (runId: string, text: string) => void
  getRun: (runId: string) => AgentRunSnapshot
  removeRun: (runId: string) => void
  stopRun: (runId: string) => void
}

const createRunId = () => randomUUID()
const MAX_RUN_OUTPUT_LENGTH = 1_000_000

export const createAgentManager = (): AgentManager => {
  const runs = new Map<string, AgentRunRecord>()

  const getRunRecord = (runId: string) => {
    const run = runs.get(runId)
    if (!run) {
      throw new Error(`Run not found: ${runId}`)
    }

    return run
  }

  const toSnapshot = (run: AgentRunRecord): AgentRunSnapshot => ({
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

  const finishRun = (run: AgentRunRecord, exitCode: number | null) => {
    if ((run.status === 'exited' || run.status === 'error') && run.exitCode !== null) {
      return
    }

    run.status = exitCode === 0 ? 'exited' : 'error'
    run.exitCode = exitCode
    run.onExit?.({ runId: run.runId, exitCode })
  }

  const attachPty = (run: AgentRunRecord, pty: IPty) => {
    run.process = {
      isStopped() {
        return run.status === 'exited' || run.status === 'error'
      },
      pid: pty.pid,
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
      if (run.status === 'starting') {
        run.status = 'running'
      }
      run.output += chunk
      if (run.output.length > MAX_RUN_OUTPUT_LENGTH) {
        run.output = run.output.slice(-MAX_RUN_OUTPUT_LENGTH)
      }
    })

    pty.onExit((event) => {
      finishRun(run, event.exitCode)
    })
  }

  return {
    async startAgent(input) {
      const runId = createRunId()
      const env = {
        ...process.env,
        ...input.env,
      }

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
          stop() {},
          write() {},
        },
      }

      if (input.onExit) {
        run.onExit = input.onExit
      }

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

      return toSnapshot(run)
    },

    writeInput(runId, text) {
      getRunRecord(runId).process.write(text)
    },

    getRun(runId) {
      return toSnapshot(getRunRecord(runId))
    },

    removeRun(runId) {
      runs.delete(runId)
    },

    stopRun(runId) {
      const run = getRunRecord(runId)
      if (run.status === 'exited' || run.status === 'error') {
        return
      }
      run.process.stop()
    },
  }
}

export type { AgentManager, AgentRunSnapshot, RunStatus, StartAgentInput }
