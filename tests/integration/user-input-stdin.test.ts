import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const originalDataDir = process.env.HIVE_DATA_DIR

const waitFor = async (
  assertion: () => void | Promise<void>,
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

afterEach(async () => {
  const paths = tempDirs.splice(0)
  try {
    const results = await Promise.allSettled(stores.splice(0).map((store) => store.close()))
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Test store cleanup failed'
      )
    }
    for (const dir of paths) {
      removeTestPath(dir)
    }
  } finally {
    if (originalDataDir === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = originalDataDir
  }
})

describe('user input stdin injection', () => {
  test('user-input endpoint rejects when the orchestrator PTY is inactive', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-user-input-inactive-'))
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
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }

      const inputResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/user-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ text: 'This should not be accepted while offline' }),
      })

      expect(inputResponse.status).toBe(409)

      const store = createRuntimeStore({ dataDir })
      stores.push(store)
      expect(store.listMessagesForRecovery(workspace.id, 0)).not.toContainEqual(
        expect.objectContaining({
          text: 'This should not be accepted while offline',
          type: 'user_input',
        })
      )
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })

  test('user-input endpoint injects text into orchestrator PTY stdin', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-user-input-stdin-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const orchScript = join(workspacePath, 'orch-echo.js')
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
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          command: process.execPath,
          args: [orchScript],
        }),
      })

      const startResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )
      const startPayload = (await startResponse.json()) as { run_id: string }

      const inputResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/user-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ text: '请继续实现登录' }),
      })

      expect(inputResponse.status).toBe(202)

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${startPayload.run_id}`, {
          headers: { cookie: uiCookie },
        })
        const run = (await runResponse.json()) as { output: string }
        expect(run.output).toContain('ORCH:请继续实现登录')
      })
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })
})
