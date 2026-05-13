import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
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
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

interface TeamMemberPayload {
  id: string
  last_output_line: string | null
  name: string
  pending_task_count: number
  role: string
  status: string
}

const fetchTeam = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string
): Promise<TeamMemberPayload[]> => {
  const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspaceId}/team`, {
    headers: { cookie },
  })
  if (response.status !== 200) {
    throw new Error(`team list returned ${response.status}`)
  }
  return (await response.json()) as TeamMemberPayload[]
}

describe('team list last_output_line', () => {
  test('exposes last non-empty PTY line of a running worker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-last-output-line-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })

    // Multi-line output so we can verify the LAST line is returned (reversibility check).
    const script = join(workspacePath, 'multi-line.js')
    writeFileSync(
      script,
      [
        "console.log('first-line-output')",
        "console.log('middle-line-output')",
        "console.log('hello-from-pty')",
        'process.stdin.resume()',
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)

      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }

      const workerResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/workers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name: 'Alice', role: 'coder' }),
        }
      )
      expect(workerResponse.status).toBe(201)
      const worker = (await workerResponse.json()) as { id: string }

      const configResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ command: process.execPath, args: [script] }),
        }
      )
      expect(configResponse.status).toBe(204)

      const port = server.baseUrl.split(':').at(-1)
      const startResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ hive_port: port }),
        }
      )
      expect(startResponse.status).toBe(201)

      await waitFor(async () => {
        const team = await fetchTeam(server.baseUrl, cookie, workspace.id)
        const member = team.find((item) => item.id === worker.id)
        expect(member).toBeDefined()
        // Reversibility check: assert the LAST printed line, not the first/middle one.
        expect(member?.last_output_line).toBe('hello-from-pty')
      })

      // Sanity: payload shape must include the field even when null is the right answer.
      const team = await fetchTeam(server.baseUrl, cookie, workspace.id)
      const member = team.find((item) => item.id === worker.id)
      expect(member && 'last_output_line' in member).toBe(true)
    } finally {
      await server.close()
    }
  }, 15000)

  test('returns null last_output_line when no run is active', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-last-output-line-null-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)

      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Beta',
          path: workspacePath,
        }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }

      const workerResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/workers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name: 'Bob', role: 'coder' }),
        }
      )
      const worker = (await workerResponse.json()) as { id: string }

      const team = await fetchTeam(server.baseUrl, cookie, workspace.id)
      const member = team.find((item) => item.id === worker.id)
      expect(member?.last_output_line).toBeNull()
    } finally {
      await server.close()
    }
  })
})
