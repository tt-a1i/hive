import type { Database } from 'better-sqlite3'

export interface MessageLogRecord {
  artifacts?: string[]
  createdAt: number
  fromAgentId?: string
  status?: string
  text: string
  toAgentId?: string
  type: 'user_input' | 'send' | 'report' | 'status' | 'system_env_sync' | 'system_recovery_summary'
  workerId: string
  workspaceId: string
}

export interface MessageLogHandle {
  sequence: number
}

interface RecoveryMessageBase {
  createdAt: number
  text: string
}

interface UserInputRecoveryMessage extends RecoveryMessageBase {
  type: 'user_input'
}

interface SendRecoveryMessage extends RecoveryMessageBase {
  type: 'send'
  from?: string
  to: string
}

interface ReportRecoveryMessage extends RecoveryMessageBase {
  artifacts: string[]
  from: string
  status?: string
  type: 'report'
}

interface StatusRecoveryMessage extends RecoveryMessageBase {
  artifacts: string[]
  from: string
  type: 'status'
}

export type RecoveryMessage =
  | UserInputRecoveryMessage
  | SendRecoveryMessage
  | ReportRecoveryMessage
  | StatusRecoveryMessage

interface MessageKindRow {
  type: 'send' | 'report'
  worker_id: string
  workspace_id: string
}

interface MessageRow {
  created_at: number
  artifacts: string | null
  from_agent_id: string | null
  status: string | null
  text: string | null
  to_agent_id: string | null
  type: 'user_input' | 'send' | 'report' | 'status' | 'system_env_sync' | 'system_recovery_summary'
  worker_id: string
}

export const createMessageLogStore = (db: Database) => {
  const listMessageKinds = () => {
    return db
      .prepare(
        `SELECT workspace_id, worker_id, type
         FROM messages
         WHERE type IN ('send', 'report')
         ORDER BY sequence ASC`
      )
      .all() as MessageKindRow[]
  }

  const insertMessage = (input: MessageLogRecord): MessageLogHandle => {
    const result = db
      .prepare(
        `INSERT INTO messages (
         workspace_id,
         worker_id,
         type,
         from_agent_id,
         to_agent_id,
         text,
         status,
         artifacts,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.workspaceId,
        input.workerId,
        input.type,
        input.fromAgentId ?? null,
        input.toAgentId ?? null,
        input.text,
        input.status ?? null,
        input.artifacts ? JSON.stringify(input.artifacts) : null,
        input.createdAt
      )
    return { sequence: Number(result.lastInsertRowid) }
  }

  const deleteMessage = (handle: MessageLogHandle) => {
    db.prepare('DELETE FROM messages WHERE sequence = ?').run(handle.sequence)
  }

  const parseArtifacts = (value: string | null) => {
    if (!value) {
      return []
    }

    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  }

  const listMessagesForRecovery = (workspaceId: string, sinceMs: number) => {
    return db
      .prepare(
        `SELECT worker_id, type, from_agent_id, to_agent_id, text, status, artifacts, created_at
         FROM messages
         WHERE workspace_id = ? AND created_at >= ?
         ORDER BY sequence ASC`
      )
      .all(workspaceId, sinceMs)
      .map((row: unknown) => {
        const typedRow = row as MessageRow

        if (typedRow.type === 'user_input') {
          return {
            createdAt: typedRow.created_at,
            text: typedRow.text ?? '',
            type: 'user_input',
          } satisfies RecoveryMessage
        }

        if (typedRow.type === 'send') {
          const message: RecoveryMessage = {
            createdAt: typedRow.created_at,
            text: typedRow.text ?? '',
            to: typedRow.to_agent_id ?? typedRow.worker_id,
            type: 'send',
          }

          if (typedRow.from_agent_id) {
            message.from = typedRow.from_agent_id
          }

          return message
        }

        if (typedRow.type !== 'report' && typedRow.type !== 'status') {
          return null
        }

        const recoveryMessage: ReportRecoveryMessage | StatusRecoveryMessage = {
          artifacts: parseArtifacts(typedRow.artifacts),
          createdAt: typedRow.created_at,
          from: typedRow.from_agent_id ?? typedRow.worker_id,
          text: typedRow.text ?? '',
          type: typedRow.type,
        }
        if (typedRow.type === 'report' && typedRow.status) {
          ;(recoveryMessage as ReportRecoveryMessage).status = typedRow.status
        }
        return recoveryMessage
      })
      .filter((message): message is RecoveryMessage => message !== null)
  }

  return {
    deleteMessage,
    insertMessage,
    listMessageKinds,
    listMessagesForRecovery,
  }
}
