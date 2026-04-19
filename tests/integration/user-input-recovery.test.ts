import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('user input recovery', () => {
  test('user-input endpoint records a persisted user_input message after restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-user-input-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string; name: string }

      const inputResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/user-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ text: '请继续实现登录' }),
      })

      expect(inputResponse.status).toBe(202)
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }

    const store = createRuntimeStore({ dataDir })
    const workspace = store.listWorkspaces()[0]
    if (!workspace) {
      throw new Error('Expected workspace after restart')
    }
    expect(store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
      expect.objectContaining({ type: 'user_input', text: '请继续实现登录' })
    )
  })
})
