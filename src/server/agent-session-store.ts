import type { Database } from './sqlite.js'

interface AgentSessionRow {
  agent_id: string
  last_session_id: string
  workspace_id: string
}

export interface AgentSessionStore {
  clearLastSessionId: (workspaceId: string, agentId: string) => void
  invalidateAfterConfigChange: (workspaceId: string, agentId: string) => void
  getRevision: (workspaceId: string, agentId: string) => number
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  setLastSessionId: (workspaceId: string, agentId: string, sessionId: string) => void
}

export const createAgentSessionStore = (db: Database): AgentSessionStore => {
  const lastSessionIds = new Map<string, string>()
  const revisions = new Map<string, number>()

  for (const row of db
    .prepare(
      'SELECT agent_id, workspace_id, last_session_id FROM agent_sessions ORDER BY updated_at ASC'
    )
    .all() as AgentSessionRow[]) {
    lastSessionIds.set(`${row.workspace_id}:${row.agent_id}`, row.last_session_id)
  }

  return {
    getRevision: (workspaceId, agentId) => revisions.get(`${workspaceId}:${agentId}`) ?? 0,
    invalidateAfterConfigChange(workspaceId, agentId) {
      const key = `${workspaceId}:${agentId}`
      lastSessionIds.delete(key)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
    },
    clearLastSessionId(workspaceId, agentId) {
      db.transaction(() => {
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?').run(
          workspaceId,
          agentId
        )
        db.prepare(
          'UPDATE workers SET last_session_id = NULL WHERE id = ? AND workspace_id = ?'
        ).run(agentId, workspaceId)
      })()
      lastSessionIds.delete(`${workspaceId}:${agentId}`)
    },
    getLastSessionId(workspaceId, agentId) {
      return lastSessionIds.get(`${workspaceId}:${agentId}`)
    },
    setLastSessionId(workspaceId, agentId, sessionId) {
      const updatedAt = Date.now()
      const workerExists = Boolean(
        db
          .prepare('SELECT 1 FROM workers WHERE workspace_id = ? AND id = ?')
          .get(workspaceId, agentId)
      )
      const isOrchestrator = agentId === `${workspaceId}:orchestrator`
      const workspaceExists =
        isOrchestrator &&
        Boolean(db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId))
      if (!workerExists && !workspaceExists) {
        lastSessionIds.delete(`${workspaceId}:${agentId}`)
        return
      }
      db.transaction(() => {
        db.prepare(
          `INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             last_session_id = excluded.last_session_id,
             updated_at = excluded.updated_at`
        ).run(agentId, workspaceId, sessionId, updatedAt)
        if (workerExists) {
          db.prepare(
            'UPDATE workers SET last_session_id = ? WHERE id = ? AND workspace_id = ?'
          ).run(sessionId, agentId, workspaceId)
        }
      })()
      lastSessionIds.set(`${workspaceId}:${agentId}`, sessionId)
    },
  }
}
