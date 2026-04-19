import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { buildRecoverySummary } from '../../src/server/recovery-summary.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('user input recovery', () => {
  test('user-input endpoint records message and recovery summary includes user line', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-user-input-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string; name: string }

      const inputResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/user-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    const summary = buildRecoverySummary({
      workspaceName: workspace.name,
      agentRole: 'orchestrator',
      tasksContent: '',
      workers: store.listWorkers(workspace.id),
      messages: store.listMessagesForRecovery(workspace.id, 0),
    })

    expect(summary).toContain('user: 请继续实现登录')
  })
})
