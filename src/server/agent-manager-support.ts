import type { IPty } from 'node-pty'

import type { AgentRunRecord, AgentRunSnapshot } from './agent-manager.js'
import type { PtyOutputBus } from './pty-output-bus.js'

export const MAX_RUN_OUTPUT_LENGTH = 1_000_000

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
  if ((run.status === 'exited' || run.status === 'error') && run.exitCode !== null) return
  run.status = exitCode === 0 ? 'exited' : 'error'
  run.exitCode = exitCode
  run.onExit?.({ runId: run.runId, exitCode })
  ptyOutputBus.clear(run.runId)
}

export const attachAgentPty = (run: AgentRunRecord, pty: IPty, ptyOutputBus: PtyOutputBus) => {
  run.process = {
    isStopped() {
      return run.status === 'exited' || run.status === 'error'
    },
    pause() {
      pty.pause()
    },
    pid: pty.pid,
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    resume() {
      pty.resume()
    },
    stop() {
      try {
        pty.kill()
      } catch (error) {
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
