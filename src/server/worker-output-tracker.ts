import type { PtyOutputBus } from './pty-output-bus.js'
import { TerminalStateMirror } from './terminal-state-mirror.js'

interface TrackedRun {
  mirror: TerminalStateMirror
  runId: string
  unsubscribe: () => void
}

export interface WorkerOutputTracker {
  attach: (workspaceId: string, agentId: string, runId: string, initialOutput: string) => void
  closeAll: () => void
  detach: (workspaceId: string, agentId: string) => void
  getLastOutputLine: (workspaceId: string, agentId: string) => string | null
}

const trackerKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`

/**
 * Maintains a headless terminal mirror per active agent run so the team-list
 * endpoint can report each worker's last output line without requiring a
 * connected UI viewer. Created on run start (via `attach`) and torn down on
 * run exit (via `detach`).
 */
export const createWorkerOutputTracker = (outputBus: PtyOutputBus): WorkerOutputTracker => {
  const tracked = new Map<string, TrackedRun>()

  const disposeEntry = (entry: TrackedRun) => {
    entry.unsubscribe()
    entry.mirror.dispose()
  }

  return {
    attach(workspaceId, agentId, runId, initialOutput) {
      const key = trackerKey(workspaceId, agentId)
      const existing = tracked.get(key)
      if (existing) {
        if (existing.runId === runId) return
        disposeEntry(existing)
      }
      const mirror = new TerminalStateMirror()
      if (initialOutput.length > 0) mirror.write(initialOutput)
      const unsubscribe = outputBus.subscribe(runId, (chunk) => {
        mirror.write(chunk)
      })
      tracked.set(key, { mirror, runId, unsubscribe })
    },
    closeAll() {
      for (const entry of tracked.values()) disposeEntry(entry)
      tracked.clear()
    },
    detach(workspaceId, agentId) {
      const key = trackerKey(workspaceId, agentId)
      const entry = tracked.get(key)
      if (!entry) return
      disposeEntry(entry)
      tracked.delete(key)
    },
    getLastOutputLine(workspaceId, agentId) {
      const entry = tracked.get(trackerKey(workspaceId, agentId))
      return entry ? entry.mirror.lastOutputLine() : null
    },
  }
}
