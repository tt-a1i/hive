import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 4000,
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

describe('agent manager PTY EOF handling (real node-pty)', () => {
  test('fast-exiting PTYs settle as exited instead of PTY error through HTTP and SQLite', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = await startTestServer()
    const startedAt = Date.now()
    let activeRunId: string | undefined
    let lastRun:
      | {
          pid: number | null
          exit_code: number | null
          output: string
          status: string
        }
      | undefined
    let iteration = 0
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const dir = join(server.dataDir, 'workspace')
      mkdirSync(dir, { recursive: true })

      const scriptPath = join(dir, 'fast-exit.js')
      writeFileSync(scriptPath, "process.stdout.write('done\\n'); process.exit(0)\n")

      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'PTY EOF', path: dir }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }

      const runIds: string[] = []
      for (let index = 0; index < 12; index += 1) {
        const workerResponse = await fetch(
          `${server.baseUrl}/api/workspaces/${workspace.id}/workers`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ name: `Alice ${index}`, role: 'coder' }),
          }
        )
        expect(workerResponse.status).toBe(201)
        const worker = (await workerResponse.json()) as { id: string }

        const configResponse = await fetch(
          `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ args: [scriptPath], command: process.execPath }),
          }
        )
        expect(configResponse.status).toBe(204)

        const response = await fetch(
          `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
          { method: 'POST', headers: { cookie } }
        )
        expect(response.status).toBe(201)
        const payload = (await response.json()) as { run_id: string }
        runIds.push(payload.run_id)
        activeRunId = payload.run_id
        lastRun = undefined
        iteration = index + 1

        await waitFor(async () => {
          const runResponse = await fetch(`${server.baseUrl}/api/runtime/runs/${payload.run_id}`, {
            headers: { cookie },
          })
          expect(runResponse.status).toBe(200)
          const runState = (await runResponse.json()) as NonNullable<typeof lastRun>
          lastRun = runState
          expect(runState).toMatchObject({
            exit_code: 0,
            output: expect.stringContaining('done'),
            status: 'exited',
          })
        })
      }

      expect(new Set(runIds).size).toBe(12)
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining('PTY error for run'),
        expect.anything()
      )
    } catch (error) {
      // Keep the original failure; capture enough to distinguish a live child
      // from a missing exit event without rerunning the whole platform job.
      const run = lastRun
      let processState = 'unknown'
      if (run?.pid) {
        try {
          process.kill(run.pid, 0)
          processState = 'alive'
        } catch (probeError) {
          processState = (probeError as NodeJS.ErrnoException).code ?? 'unknown'
        }
      }
      console.warn('PTY EOF failure context', {
        iteration,
        activeRunId,
        elapsedMs: Date.now() - startedAt,
        node: process.version,
        platform: process.platform,
        run,
        processState,
        errors: consoleError.mock.calls,
      })
      throw error
    } finally {
      consoleError.mockRestore()
      await server.close()
    }
  }, 60000)
})
