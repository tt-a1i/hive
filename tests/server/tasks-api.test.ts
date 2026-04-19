import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTasksFileService } from '../../src/server/tasks-file.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => void }> = []

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
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

  servers.push(app.server)

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
  test('GET returns current tasks.md content and PUT persists updates', async () => {
    const { baseUrl, workspace } = await startServer()

    const initialResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`)

    expect(initialResponse.status).toBe(200)
    await expect(initialResponse.json()).resolves.toEqual({ content: '' })

    const updateResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '- [ ] implement login\n' }),
    })

    expect(updateResponse.status).toBe(200)
    await expect(updateResponse.json()).resolves.toEqual({
      content: '- [ ] implement login\n',
    })

    const readBackResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`)

    await expect(readBackResponse.json()).resolves.toEqual({
      content: '- [ ] implement login\n',
    })
  })
})
