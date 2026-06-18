import type { AgentManager } from './agent-manager.js'
import type { createAgentRunStore } from './agent-run-store.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { isSessionAlive, killSession, listHiveSessions } from './tmux-session-manager.js'

export const reattachSurvivedSessions = ({
  agentManager,
  agentRunStore,
  registry,
}: {
  agentManager: AgentManager
  agentRunStore: ReturnType<typeof createAgentRunStore>
  registry: LiveRunRegistry
}): number => {
  const sessions = listHiveSessions()
  let reattached = 0

  for (const sessionName of sessions) {
    if (!isSessionAlive(sessionName)) continue

    const persistedRun = agentRunStore.findRunByTmuxSession(sessionName)
    if (!persistedRun) {
      killSession(sessionName)
      continue
    }

    try {
      if (!agentManager.reattachTmuxRun) {
        killSession(sessionName)
        continue
      }
      const snapshot = agentManager.reattachTmuxRun(
        persistedRun.runId,
        persistedRun.agentId,
        sessionName
      )
      registry.add({
        runId: snapshot.runId,
        agentId: snapshot.agentId,
        pid: snapshot.pid,
        status: 'running',
        output: '',
        exitCode: null,
        startedAt: persistedRun.startedAt,
      })
      reattached++
    } catch {
      killSession(sessionName)
    }
  }

  return reattached
}
