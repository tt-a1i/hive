import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 1500,
  intervalMs = 20
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

describe('hive bin dir', () => {
  test('dummy agent can resolve team via injected HIVE_BIN_DIR on PATH', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-bin-dir-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const scriptPath = join(workspacePath, 'which-team.js')
    writeFileSync(
      scriptPath,
      "import { execSync } from 'node:child_process'\nconsole.log(execSync('which team', { encoding: 'utf8' }).trim())\nsetTimeout(() => process.exit(0), 10)\n"
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
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const configResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `"${process.execPath}" "${scriptPath}"`],
          }),
        }
      )
      expect(configResponse.status).toBe(204)

      const teamResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
        headers: { cookie: uiCookie },
      })
      expect(teamResponse.status).toBe(200)

      const startResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )

      if (startResponse.status !== 201) {
        throw new Error(`start failed: ${await startResponse.text()}`)
      }
      expect(startResponse.status).toBe(201)
      const payload = (await startResponse.json()) as { runId: string }

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${payload.runId}`, {
          headers: { cookie: uiCookie },
        })

        expect(runResponse.status).toBe(200)
        await expect(runResponse.json()).resolves.toEqual(
          expect.objectContaining({
            output: expect.stringContaining('/dist/bin/team'),
            runId: payload.runId,
            status: 'exited',
          })
        )
      })

      const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${payload.runId}`, {
        headers: { cookie: uiCookie },
      })

      expect(runResponse.status).toBe(200)
      await expect(runResponse.json()).resolves.toEqual(
        expect.objectContaining({
          output: expect.stringContaining('/dist/bin/team'),
          runId: payload.runId,
          status: 'exited',
        })
      )
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  })
})
