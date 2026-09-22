import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { startTestServer } from '../helpers/test-server.js'

test('workspace deletion followed by runtime shutdown safely stops starting PTYs', async () => {
  for (let iteration = 0; iteration < 10; iteration++) {
    const server = await startTestServer()
    try {
      const path = join(server.dataDir, 'workspace')
      mkdirSync(path)
      const workspace = server.store.createWorkspace(path, 'Stop race fixture')
      const orchestratorId = `${workspace.id}:orchestrator`
      server.store.configureAgentLaunch(workspace.id, orchestratorId, {
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
      })
      await server.store.startAgent(workspace.id, orchestratorId, {
        hivePort: new URL(server.baseUrl).port,
      })
      expect(server.store.getActiveRunByAgentId(workspace.id, orchestratorId)?.runId).toBeTypeOf(
        'string'
      )
      await server.store.deleteWorkspace(workspace.id)
      expect(server.store.listWorkspaces()).toEqual([])
    } finally {
      await server.close()
    }
  }
}, 30_000)

test('deletion and shutdown terminate the real child, not only its workspace record', async () => {
  const server = await startTestServer()
  let stoppedPid = 0
  try {
    const path = join(server.dataDir, 'workspace')
    mkdirSync(path)
    const pidFile = join(path, 'child.pid')
    const workspace = server.store.createWorkspace(path, 'Process exit fixture')
    const orchestratorId = `${workspace.id}:orchestrator`
    server.store.configureAgentLaunch(workspace.id, orchestratorId, {
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume()`,
      ],
    })
    await server.store.startAgent(workspace.id, orchestratorId, {
      hivePort: new URL(server.baseUrl).port,
    })
    await expect.poll(() => existsSync(pidFile), { timeout: 5000 }).toBe(true)
    stoppedPid = Number(readFileSync(pidFile, 'utf8'))
    expect(stoppedPid).toBeGreaterThan(0)
    expect(Number.isInteger(stoppedPid)).toBe(true)
    await server.store.deleteWorkspace(workspace.id)
    expect(server.store.listWorkspaces()).toEqual([])
  } finally {
    await server.close()
  }
  await expect
    .poll(
      () => {
        try {
          process.kill(stoppedPid, 0)
          return 'alive'
        } catch (error) {
          return (error as NodeJS.ErrnoException).code
        }
      },
      { timeout: 5000 }
    )
    .toBe('ESRCH')
}, 30_000)
