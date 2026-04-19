import '../helpers/mock-node-pty.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getUiCookie } from '../helpers/ui-session.js'

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

describe('runtime runs api (unit)', () => {
  test('GET /api/runtime/runs/:runId returns live run snapshot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-run-api-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const scriptPath = join(workspacePath, 'echo.js')
    writeFileSync(scriptPath, "setTimeout(() => process.exit(0), 50)\nconsole.log('ready')\n")

    const store = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      command: 'node',
      args: [scriptPath],
    })

    const run = await store.startAgent(workspace.id, orchestrator.id, {
      hivePort: '4010',
    })

    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)

    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to an inet port')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/runtime/runs/${run.runId}`, {
      headers: { cookie },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        agentId: orchestrator.id,
        runId: run.runId,
      })
    )
  })
})
