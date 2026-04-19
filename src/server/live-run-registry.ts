import type { LiveAgentRun } from './agent-runtime-types.js'

export interface RunExitEntry {
  promise: Promise<void>
  resolve: () => void
}

export interface LiveRunRegistry {
  add: (run: LiveAgentRun) => void
  createExitEntry: (runId: string) => void
  deleteExitEntry: (runId: string) => void
  get: (runId: string) => LiveAgentRun | undefined
  getExitEntry: (runId: string) => RunExitEntry | undefined
  list: () => LiveAgentRun[]
  listExitEntries: () => RunExitEntry[]
  pendingExitCodes: Map<string, number | null>
}

export const createLiveRunRegistry = (): LiveRunRegistry => {
  const liveRuns = new Map<string, LiveAgentRun>()
  const pendingExitCodes = new Map<string, number | null>()
  const runExitPromises = new Map<string, RunExitEntry>()

  return {
    add(run) {
      liveRuns.set(run.runId, run)
    },
    createExitEntry(runId) {
      let resolve = () => {}
      const promise = new Promise<void>((nextResolve) => {
        resolve = nextResolve
      })
      runExitPromises.set(runId, { promise, resolve })
    },
    deleteExitEntry(runId) {
      runExitPromises.delete(runId)
    },
    get(runId) {
      return liveRuns.get(runId)
    },
    getExitEntry(runId) {
      return runExitPromises.get(runId)
    },
    list() {
      return Array.from(liveRuns.values())
    },
    listExitEntries() {
      return Array.from(runExitPromises.values())
    },
    pendingExitCodes,
  }
}
