import '../helpers/mock-node-pty.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => void }> = []

const waitFor = async (assertion: () => void, timeoutMs = 1500, intervalMs = 20) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('team runtime flow (unit)', () => {
  test('team send injects prompt into active worker run and records a real message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-send-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const workerScript = join(workspacePath, 'worker-echo.js')
    writeFileSync(
      workerScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('PROMPT:' + chunk)",
        '})',
      ].join('\n')
    )

    const store = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript],
    })
    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      command: '/bin/bash',
      args: ['-lc', `${process.execPath} -e "process.stdin.resume()"`],
    })

    await store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
    })
    await store.startAgent(workspace.id, orchestrator.id, {
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

    const response = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: orchestrator.id,
        token: store.peekAgentToken(orchestrator.id),
        to: 'Alice',
        text: '实现登录\n并补测试',
      }),
    })

    expect(response.status).toBe(202)

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      expect(run?.output).toContain('PROMPT:')
      expect(run?.output).toContain('实现登录')
      expect(run?.output).toContain('并补测试')
    })

    expect(store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
      expect.objectContaining({
        from: orchestrator.id,
        text: '实现登录\n并补测试',
        to: worker.id,
        type: 'send',
      })
    )
  })

  test('team report injects a system message into active orchestrator run and records message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-report-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const orchestratorScript = join(workspacePath, 'orch-echo.js')
    writeFileSync(
      orchestratorScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('ORCH:' + chunk)",
        '})',
      ].join('\n')
    )

    const store = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      command: process.execPath,
      args: [orchestratorScript],
    })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: '/bin/bash',
      args: ['-lc', `${process.execPath} -e "process.stdin.resume()"`],
    })

    await store.startAgent(workspace.id, orchestrator.id, {
      hivePort: '4010',
    })
    await store.startAgent(workspace.id, worker.id, {
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

    const response = await fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: worker.id,
        token: store.peekAgentToken(worker.id),
        result: '登录接口已完成',
        status: 'success',
        artifacts: ['src/auth.ts'],
      }),
    })

    expect(response.status).toBe(202)

    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, orchestrator.id)
      expect(run?.output).toContain('ORCH:')
      expect(run?.output).toContain('登录接口已完成')
      expect(run?.output).toContain('src/auth.ts')
    })

    expect(store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
      expect.objectContaining({
        from: worker.id,
        status: 'success',
        text: '登录接口已完成',
        type: 'report',
      })
    )
  })
})
