import type { AgentManager } from './agent-manager.js'
import type { PtyOutputBus } from './pty-output-bus.js'

interface FlowAdapterManager {
  getOutputBus: () => PtyOutputBus
  pauseRun: (runId: string) => void
  resizeRun: (runId: string, cols: number, rows: number) => void
  resumeRun: (runId: string) => void
}

export const createAgentRuntimeFlowAdapter = (
  requireManager: () => AgentManager
): FlowAdapterManager => ({
  getOutputBus() {
    return requireManager().getOutputBus()
  },
  pauseRun(runId) {
    requireManager().pauseRun(runId)
  },
  resizeRun(runId, cols, rows) {
    requireManager().resizeRun(runId, cols, rows)
  },
  resumeRun(runId) {
    requireManager().resumeRun(runId)
  },
})
