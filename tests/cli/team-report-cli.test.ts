import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalEnv = { ...process.env }

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

afterEach(() => {
  process.env = { ...originalEnv }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('team report cli', () => {
  test('team report writes through to orchestrator stdin and records message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-report-cli-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const orchScript = join(workspacePath, 'orch-echo.js')
    writeFileSync(
      orchScript,
      "process.stdin.setEncoding('utf8')\nprocess.stdin.on('data', c => process.stdout.write('ORCH:' + c))\n"
    )

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
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`
      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          command: '/bin/bash',
          args: ['-lc', `"${process.execPath}" "${orchScript}"`],
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
      const run = (await startResponse.json()) as { runId: string }

      const workerConfig = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `${process.execPath} -e "process.stdin.resume()"`],
          }),
        }
      )
      if (workerConfig.status !== 204) {
        throw new Error(`Failed to configure worker: ${await workerConfig.text()}`)
      }
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })

      const workerToken = hive.store.peekAgentToken(worker.id)
      if (!workerToken) {
        throw new Error('Expected worker token after start')
      }
      const orchestratorToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchestratorToken) {
        throw new Error('Expected orchestrator token after start')
      }
      process.env = {
        ...originalEnv,
        HIVE_AGENT_ID: orchestratorId,
        HIVE_AGENT_TOKEN: orchestratorToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }
      await runTeamCommand(['send', 'Alice', 'Report this CLI task'])
      process.env = {
        ...originalEnv,
        HIVE_AGENT_ID: worker.id,
        HIVE_AGENT_TOKEN: workerToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }
      await runTeamCommand(['report', 'Done via CLI', '--artifact', 'src/auth.ts'])

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${run.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await runResponse.json()) as { output: string }
        expect(body.output).toContain('Done via CLI')
        expect(body.output).toContain('src/auth.ts')
        expect(body.output).not.toContain('状态:')
        expect(body.output).not.toContain('success')
      })
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })
})
