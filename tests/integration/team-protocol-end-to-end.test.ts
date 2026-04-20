import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => Promise<void> | void,
  timeoutMs = 2000,
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('team protocol end to end', () => {
  test('real hive runtime records send/report messages and updates worker status', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-e2e-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const workerScript = join(workspacePath, 'dummy-worker.js')
    writeFileSync(
      workerScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('WORKER:' + chunk)",
        '})',
      ].join('\n')
    )

    const orchScript = join(workspacePath, 'dummy-orch.js')
    writeFileSync(
      orchScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('ORCH:' + chunk)",
        '})',
      ].join('\n')
    )

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const sessionResponse = await fetch(`${baseUrl}/api/ui/session`)
      const cookie = sessionResponse.headers.get('set-cookie')
      if (!cookie) {
        throw new Error('Expected UI session cookie')
      }
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      expect(workerResponse.status).toBe(201)
      const worker = (await workerResponse.json()) as { id: string }

      const orchConfig = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `"${process.execPath}" "${orchScript}"`],
          }),
        }
      )
      expect(orchConfig.status).toBe(204)

      const workerConfig = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `"${process.execPath}" "${workerScript}"`],
          }),
        }
      )
      expect(workerConfig.status).toBe(204)

      const orchStart = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )
      expect(orchStart.status).toBe(201)

      const workerStart = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )
      expect(workerStart.status).toBe(201)

      const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: hive.store.peekAgentToken(orchestratorId),
          to: 'Alice',
          text: '实现登录接口',
        }),
      })
      expect(sendResponse.status).toBe(202)

      const reportResponse = await fetch(`${baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: worker.id,
          token: hive.store.peekAgentToken(worker.id),
          result: '已完成登录接口',
          status: 'success',
          artifacts: ['src/auth.ts'],
        }),
      })
      expect(reportResponse.status).toBe(202)

      await waitFor(async () => {
        const teamResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
          headers: { cookie },
        })
        expect(teamResponse.status).toBe(200)
        const team = (await teamResponse.json()) as Array<{
          id: string
          pending_task_count: number
          status: string
        }>

        expect(team).toContainEqual(
          expect.objectContaining({
            id: worker.id,
            pending_task_count: 0,
            status: 'idle',
          })
        )
      })

      const runtimeStore = createRuntimeStore({ dataDir })
      const messages = runtimeStore.listMessagesForRecovery(workspace.id, 0)
      expect(messages).toHaveLength(2)
      expect(messages).toContainEqual(
        expect.objectContaining({ type: 'send', to: worker.id, text: '实现登录接口' })
      )
      expect(messages).toContainEqual(
        expect.objectContaining({ type: 'report', from: worker.id, text: '已完成登录接口' })
      )
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })
})
