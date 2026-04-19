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
  clearPendingExitCode: (runId: string) => void
  getPendingExitCode: (runId: string) => number | null | undefined
  hasPendingExitCode: (runId: string) => boolean
  list: () => LiveAgentRun[]
  listExitEntries: () => RunExitEntry[]
  remove: (runId: string) => void
  resolveExit: (runId: string) => void
  setPendingExitCode: (runId: string, exitCode: number | null) => void
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
    clearPendingExitCode(runId) {
      pendingExitCodes.delete(runId)
    },
    get(runId) {
      return liveRuns.get(runId)
    },
    getExitEntry(runId) {
      return runExitPromises.get(runId)
    },
    getPendingExitCode(runId) {
      return pendingExitCodes.get(runId)
    },
    hasPendingExitCode(runId) {
      return pendingExitCodes.has(runId)
    },
    list() {
      return Array.from(liveRuns.values())
    },
    listExitEntries() {
      return Array.from(runExitPromises.values())
    },
    remove(runId) {
      liveRuns.delete(runId)
      pendingExitCodes.delete(runId)
      runExitPromises.delete(runId)
    },
    resolveExit(runId) {
      runExitPromises.get(runId)?.resolve()
    },
    setPendingExitCode(runId, exitCode) {
      pendingExitCodes.set(runId, exitCode)
    },
  }
}
