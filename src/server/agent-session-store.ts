import type { Database } from './sqlite.js'

interface AgentSessionRow {
  last_session_id: string
}

export interface AgentSessionStore {
  clearLastSessionId: (workspaceId: string, agentId: string) => void
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  setLastSessionId: (workspaceId: string, agentId: string, sessionId: string) => void
}

export const createAgentSessionStore = (db: Database): AgentSessionStore => {
  return {
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
    },
    getLastSessionId(workspaceId, agentId) {
      // A surrounding launch-config transaction can still roll back after a
      // nested session write. Read SQLite's state rather than cache it early.
      const row = db
        .prepare(
          'SELECT last_session_id FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
        )
        .get(workspaceId, agentId) as AgentSessionRow | undefined
      return row?.last_session_id
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
    },
  }
}
