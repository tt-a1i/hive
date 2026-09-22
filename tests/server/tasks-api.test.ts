import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTasksFileService } from '../../src/server/tasks-file.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, {
      force: true,
      maxRetries: process.platform === 'win32' ? 20 : 0,
      recursive: true,
    })
  }
})

const startServer = async () => {
  const dataDir = join(tmpdir(), `hive-tasks-api-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  tempDirs.push(dataDir)

  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })

  const store = createRuntimeStore({ dataDir })
  const workspace = store.createWorkspace(workspacePath, 'Alpha')
  const app = createApp({ store, tasksFileService: createTasksFileService() })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push({
    async close() {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    },
  })

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    workspace,
  }
}

describe('tasks api', () => {
  test('preserves mixed Unicode and Markdown through PUT, disk, and GET', async () => {
    const { baseUrl, workspace } = await startServer()
    const cookie = await getUiCookie(baseUrl)
    const content = '# 任务 🚀\n\n- [ ] 中文，English `code` [链接](https://example.com/路径)\n'

    const updateResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content }),
    })
    expect(updateResponse.status).toBe(200)
    await expect(updateResponse.json()).resolves.toEqual({ content })
    expect(readFileSync(join(workspace.path, '.hive', 'tasks.md'), 'utf8')).toBe(content)

    const readResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      headers: { cookie },
    })
    expect(readResponse.status).toBe(200)
    await expect(readResponse.json()).resolves.toEqual({ content })
  })

  test('GET returns current .hive/tasks.md content and PUT persists updates there', async () => {
    const { baseUrl, workspace } = await startServer()
    const cookie = await getUiCookie(baseUrl)
    const hiveTasksPath = join(workspace.path, '.hive', 'tasks.md')
    const legacyTasksPath = join(workspace.path, 'tasks.md')

    const initialResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      headers: { cookie },
    })

    expect(initialResponse.status).toBe(200)
    await expect(initialResponse.json()).resolves.toEqual({ content: '' })

    const updateResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: '- [ ] implement login\n' }),
    })

    expect(updateResponse.status).toBe(200)
    await expect(updateResponse.json()).resolves.toEqual({
      content: '- [ ] implement login\n',
    })
    expect(readFileSync(hiveTasksPath, 'utf8')).toBe('- [ ] implement login\n')
    expect(existsSync(legacyTasksPath)).toBe(false)

    const readBackResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      headers: { cookie },
    })

    await expect(readBackResponse.json()).resolves.toEqual({
      content: '- [ ] implement login\n',
    })
  })
})
