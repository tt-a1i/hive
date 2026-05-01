import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 4000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

const toWsUrl = (baseUrl: string, suffix: string) => baseUrl.replace('http://', 'ws://') + suffix

const openSocket = async (url: string, cookie: string) => {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('tasks watcher websocket', () => {
  test('external .hive/tasks.md change broadcasts tasks-updated over websocket', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-tasks-watcher-ws-'))
    tempDirs.push(workspacePath)
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })
    writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [ ] initial\n', 'utf8')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      await server.store.startWorkspaceWatch(workspace.id)
      const socket = await openSocket(toWsUrl(server.baseUrl, `/ws/tasks/${workspace.id}`), cookie)
      const messages: string[] = []
      socket.on('message', (chunk) => messages.push(chunk.toString()))

      writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [x] updated externally\n', 'utf8')

      await waitFor(() => {
        const payload = messages.map(
          (message) => JSON.parse(message) as { content: string; type: string }
        )
        expect(payload).toContainEqual({
          type: 'tasks-updated',
          content: '- [x] updated externally\n',
        })
      })

      socket.close()
    } finally {
      await server.close()
    }
  })
})
