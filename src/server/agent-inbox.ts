import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export class InboxWriteError extends Error {
  constructor(cause: unknown) {
    super('Hive could not persist the system message in its inbox', { cause })
    this.name = 'InboxWriteError'
  }
}

export interface InboxMessageMetadata {
  kind: string
  dispatchIds?: string[]
}

export const createAgentInbox = (dataDir?: string) => {
  const ephemeral = dataDir === undefined
  const root = resolve(
    ephemeral ? mkdtempSync(join(tmpdir(), 'hive-inbox-')) : join(dataDir, 'inbox')
  )
  const workspacePath = (workspaceId: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) throw new Error('Invalid inbox workspace ID')
    return join(root, workspaceId)
  }
  return {
    prepare(
      workspaceId: string,
      payload: string,
      metadata: InboxMessageMetadata = { kind: 'system' }
    ) {
      if (
        !/^[a-z_]+$/.test(metadata.kind) ||
        metadata.dispatchIds?.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))
      )
        throw new Error('Invalid inbox metadata')
      if (payload.length <= 400 && !/[\p{Cc}\u2028\u2029]/u.test(payload)) return payload
      const directory = workspacePath(workspaceId)
      const id = randomUUID()
      const path = join(directory, `${id}.md`)
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        chmodSync(root, 0o700)
        chmodSync(directory, 0o700)
        const temporary = join(directory, `.${id}.tmp`)
        try {
          writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600 })
          renameSync(temporary, path)
        } finally {
          rmSync(temporary, { force: true })
        }
      } catch (error) {
        throw new InboxWriteError(error)
      }
      const dispatches = metadata.dispatchIds ?? []
      const summary = dispatches.length
        ? ` dispatch_id=${dispatches.slice(0, 8).join(',')}${dispatches.length > 8 ? `,+${dispatches.length - 8}` : ''}`
        : ''
      return `[hive-inbox ${id} type=${metadata.kind}${summary}] Read ${JSON.stringify(path)} for the complete Hive system message.`
    },
    deleteWorkspace(workspaceId: string) {
      rmSync(workspacePath(workspaceId), { recursive: true, force: true })
    },
    close() {
      if (ephemeral) rmSync(root, { recursive: true, force: true })
    },
  }
}
export type AgentInbox = ReturnType<typeof createAgentInbox>
