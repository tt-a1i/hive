import type { Database } from 'better-sqlite3'

interface AgentSessionRow {
  agent_id: string
  last_session_id: string
  workspace_id: string
}

export interface AgentSessionStore {
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  setLastSessionId: (workspaceId: string, agentId: string, sessionId: string) => void
}

export const createAgentSessionStore = (db: Database | undefined): AgentSessionStore => {
  const lastSessionIds = new Map<string, string>()

  if (db) {
    for (const row of db
      .prepare(
        'SELECT agent_id, workspace_id, last_session_id FROM agent_sessions ORDER BY updated_at ASC'
      )
      .all() as AgentSessionRow[]) {
      lastSessionIds.set(`${row.workspace_id}:${row.agent_id}`, row.last_session_id)
    }
  }

  return {
    getLastSessionId(workspaceId, agentId) {
      return lastSessionIds.get(`${workspaceId}:${agentId}`)
    },
    setLastSessionId(workspaceId, agentId, sessionId) {
      lastSessionIds.set(`${workspaceId}:${agentId}`, sessionId)
      const updatedAt = Date.now()
      db?.prepare(
        `INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           last_session_id = excluded.last_session_id,
           updated_at = excluded.updated_at`
      ).run(agentId, workspaceId, sessionId, updatedAt)
      db?.prepare('UPDATE workers SET last_session_id = ? WHERE id = ? AND workspace_id = ?').run(
        sessionId,
        agentId,
        workspaceId
      )
    },
  }
}
