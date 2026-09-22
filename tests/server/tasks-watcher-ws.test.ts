import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { openRawWebSocket, writeRsv2Rsv3MalformedFrame } from '../helpers/raw-websocket.js'
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

const openSocketAndReadFirstMessage = async (url: string, cookie: string) => {
  return await new Promise<{ message: string; socket: WebSocket }>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } })
    socket.once('message', (chunk) => resolve({ message: chunk.toString(), socket }))
    socket.once('error', reject)
  })
}

const expectUpgradeStatus = async (
  url: string,
  cookie: string,
  statusCode: number,
  headers: Record<string, string> = {}
) => {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, ...headers } })
    socket.once('unexpected-response', (_request, response) => {
      try {
        expect(response.statusCode).toBe(statusCode)
        response.resume()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    socket.once('open', () => reject(new Error('Expected websocket upgrade to fail')))
    socket.once('error', () => {})
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('tasks watcher websocket', () => {
  test('rejects task watcher upgrades from non-local origins', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/tasks/missing'), cookie, 403, {
        Origin: 'https://attacker.example',
      })
    } finally {
      await server.close()
    }
  })

  test('allows task watcher upgrades from a local origin before workspace lookup', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/tasks/missing'), cookie, 404, {
        Origin: server.baseUrl,
      })
    } finally {
      await server.close()
    }
  })

  test('rejects task watcher upgrades from non-local hosts', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/tasks/missing'), cookie, 403, {
        Host: 'attacker.example',
      })
    } finally {
      await server.close()
    }
  })

  test('sends the current tasks snapshot when a socket opens', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-tasks-snapshot-ws-'))
    tempDirs.push(workspacePath)
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })
    writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [ ] initial\n', 'utf8')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const { message, socket } = await openSocketAndReadFirstMessage(
        toWsUrl(server.baseUrl, `/ws/tasks/${workspace.id}`),
        cookie
      )

      expect(JSON.parse(message)).toEqual({
        type: 'tasks-snapshot',
        content: '- [ ] initial\n',
      })
      socket.close()
    } finally {
      await server.close()
    }
  })

  test('malformed established task watcher websocket frames are handled without crashing the runtime', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-tasks-malformed-ws-'))
    tempDirs.push(workspacePath)
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })
    writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [ ] initial\n', 'utf8')

    const server = await startTestServer()
    let rawSocket: Awaited<ReturnType<typeof openRawWebSocket>> | undefined
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      rawSocket = await openRawWebSocket(server.baseUrl, `/ws/tasks/${workspace.id}`, cookie)

      writeRsv2Rsv3MalformedFrame(rawSocket)

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining(`tasks ${workspace.id} websocket error`),
          expect.objectContaining({
            code: 'WS_ERR_UNEXPECTED_RSV_2_3',
            message: 'Invalid WebSocket frame: RSV2 and RSV3 must be clear',
          })
        )
      })
      const response = await fetch(`${server.baseUrl}/api/ui/session`)
      expect(response.status).toBe(200)
    } finally {
      rawSocket?.destroy()
      await server.close()
    }
  })

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
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      await server.store.startWorkspaceWatch(workspace.id)
      const socket = await openSocket(toWsUrl(server.baseUrl, `/ws/tasks/${workspace.id}`), cookie)
      const messages: string[] = []
      socket.on('message', (chunk) => messages.push(chunk.toString()))
      let writeCount = 0
      const updateTasks = () => {
        writeCount += 1
        writeFileSync(
          join(workspacePath, '.hive', 'tasks.md'),
          `- [x] updated externally ${writeCount}\n`,
          'utf8'
        )
      }
      updateTasks()
      const writer = setInterval(updateTasks, 100)

      try {
        await waitFor(() => {
          const payload = messages.map(
            (message) => JSON.parse(message) as { content: string; type: string }
          )
          expect(
            payload.some(
              (message) =>
                message.type === 'tasks-updated' &&
                message.content.startsWith('- [x] updated externally ')
            )
          ).toBe(true)
        })
      } finally {
        clearInterval(writer)
        socket.close()
      }
    } finally {
      await server.close()
    }
  })

  test('PUT /tasks broadcasts the saved content after Hive atomically replaces tasks.md', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-tasks-api-watcher-ws-'))
    tempDirs.push(workspacePath)
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })
    writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [ ] initial\n', 'utf8')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      await server.store.startWorkspaceWatch(workspace.id)
      const socket = await openSocket(toWsUrl(server.baseUrl, `/ws/tasks/${workspace.id}`), cookie)
      const messages: string[] = []
      socket.on('message', (chunk) => messages.push(chunk.toString()))

      const content = '# 任务 🚀\n\n- [x] 中文，English `code` [链接](https://example.com/路径)\n'
      const updateResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/tasks`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ content }),
      })
      expect(updateResponse.status).toBe(200)

      try {
        await waitFor(() => {
          const payload = messages.map(
            (message) => JSON.parse(message) as { content: string; type: string }
          )
          expect(payload).toContainEqual({
            type: 'tasks-updated',
            content,
          })
        })
      } finally {
        socket.close()
      }
    } finally {
      await server.close()
    }
  })
})
