import type { Database } from 'better-sqlite3'

export interface MessageLogRecord {
  artifacts?: string[]
  createdAt: number
  fromAgentId?: string
  status?: string
  text: string
  toAgentId?: string
  type: 'user_input' | 'send' | 'report'
  workerId: string
  workspaceId: string
}

export interface MessageLogHandle {
  kind: 'db' | 'memory'
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
  status: string
  type: 'report'
}

export type RecoveryMessage = UserInputRecoveryMessage | SendRecoveryMessage | ReportRecoveryMessage

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
  type: 'user_input' | 'send' | 'report'
  worker_id: string
}

export const createMessageLogStore = (db: Database | undefined) => {
  let memorySequence = 0
  const memoryMessages = new Map<number, MessageLogRecord>()

  const initialize = () => {}

  const listMessageKinds = () => {
    if (!db) {
      return []
    }

    return db
      .prepare('SELECT workspace_id, worker_id, type FROM messages ORDER BY sequence ASC')
      .all() as MessageKindRow[]
  }

  const insertMessage = (input: MessageLogRecord): MessageLogHandle => {
    if (!db) {
      memorySequence += 1
      memoryMessages.set(memorySequence, input)
      return { kind: 'memory', sequence: memorySequence }
    }

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
    return { kind: 'db', sequence: Number(result.lastInsertRowid) }
  }

  const deleteMessage = (handle: MessageLogHandle) => {
    if (handle.kind === 'memory') {
      memoryMessages.delete(handle.sequence)
      return
    }

    db?.prepare('DELETE FROM messages WHERE sequence = ?').run(handle.sequence)
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
    if (!db) {
      return Array.from(memoryMessages.values())
        .filter((message) => message.workspaceId === workspaceId && message.createdAt >= sinceMs)
        .map((message) => {
          if (message.type === 'user_input') {
            return {
              createdAt: message.createdAt,
              text: message.text,
              type: 'user_input' as const,
            } satisfies RecoveryMessage
          }

          if (message.type === 'send') {
            const recoveryMessage: RecoveryMessage = {
              createdAt: message.createdAt,
              text: message.text,
              to: message.toAgentId ?? message.workerId,
              type: 'send',
            }

            if (message.fromAgentId) {
              recoveryMessage.from = message.fromAgentId
            }

            return recoveryMessage
          }

          return {
            artifacts: message.artifacts ?? [],
            createdAt: message.createdAt,
            from: message.fromAgentId ?? message.workerId,
            status: message.status ?? 'success',
            text: message.text,
            type: 'report' as const,
          } satisfies RecoveryMessage
        })
    }

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

        return {
          artifacts: parseArtifacts(typedRow.artifacts),
          createdAt: typedRow.created_at,
          from: typedRow.from_agent_id ?? typedRow.worker_id,
          status: typedRow.status ?? 'success',
          text: typedRow.text ?? '',
          type: 'report' as const,
        } satisfies RecoveryMessage
      })
  }

  return {
    deleteMessage,
    initialize,
    insertMessage,
    listMessageKinds,
    listMessagesForRecovery,
  }
}
