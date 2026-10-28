import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const paths: string[] = []
afterEach(async () => {
  const errors: unknown[] = []
  try {
    const results = await Promise.allSettled(
      servers.splice(0).map(async (server) => server.close())
    )
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason)
    }
  } finally {
    try {
      vi.unstubAllEnvs()
    } catch (error) {
      errors.push(error)
    }
    for (const path of paths.splice(0)) {
      try {
        removeTestPath(path)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Startup command test cleanup failed')
})
const workspacePath = () => {
  const path = mkdtempSync(join(tmpdir(), 'hive-startup-text-'))
  paths.push(path)
  return path
}

test.skipIf(process.platform === 'win32').each(['worker', 'orchestrator'] as const)(
  '%s startup preserves command text through HTTP and native PTY',
  async (kind) => {
    vi.stubEnv('SHELL', '/bin/sh')
    vi.stubEnv('ENV', undefined)
    vi.stubEnv('BASH_ENV', undefined)
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const post = async (path: string, body: object) => {
      const response = await fetch(`${server.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      })
      expect(response.status).toBe(201)
      return response.json() as Promise<{
        id: string
        status: string
        agent_start: { ok: boolean; run_id: string | null }
        orchestrator_start: { ok: boolean; run_id: string | null }
      }>
    }
    for (const command of ['printf %s hello', `  printf %s hello${String.fromCharCode(92)} `]) {
      const direct = spawnSync('/bin/sh', ['-ic', command], { timeout: 5_000 })
      expect(direct.error).toBeUndefined()
      expect(direct.status).toBe(0)
      expect(direct.stdout.toString()).toBe(command.endsWith(' ') ? 'hello ' : 'hello')
      const workspace = await post('/api/workspaces', {
        name: 'Command text',
        path: workspacePath(),
        autostart_orchestrator: kind === 'orchestrator',
        ...(kind === 'orchestrator' ? { startup_command: command } : {}),
      })
      const agent =
        kind === 'worker'
          ? await post(`/api/workspaces/${workspace.id}/workers`, {
              name: 'TextWorker',
              role: 'coder',
              autostart: true,
              startup_command: command,
            })
          : workspace
      const start = kind === 'worker' ? agent.agent_start : agent.orchestrator_start
      expect(start.ok).toBe(true)
      expect(start.run_id).toBeTypeOf('string')
      if (!start.run_id) throw new Error('Missing native run')
      const runId = start.run_id
      await vi.waitFor(() => expect(server.store.getLiveRun(runId).status).toBe('exited'), {
        timeout: 5_000,
      })
      const run = server.store.getLiveRun(runId)
      expect(run.exitCode).toBe(0)
      expect(Buffer.from(run.output)).toEqual(direct.stdout)
      const agentId = kind === 'worker' ? agent.id : `${workspace.id}:orchestrator`
      expect(server.store.peekAgentLaunchConfig(workspace.id, agentId)).toMatchObject({
        command: '/bin/sh',
        args: ['-ic', command],
        interactiveCommand: 'printf',
      })
    }
    if (kind === 'worker') {
      const workspace = await post('/api/workspaces', {
        name: 'Blank text',
        path: workspacePath(),
        autostart_orchestrator: false,
      })
      for (const command of ['', ' \t\n ']) {
        const worker = await post(`/api/workspaces/${workspace.id}/workers`, {
          name: command ? 'Blank' : 'Empty',
          role: 'coder',
          autostart: true,
          startup_command: command,
        })
        expect(worker.status).toBe('stopped')
        expect(worker.agent_start).toMatchObject({ ok: false, run_id: null })
        expect(server.store.peekAgentLaunchConfig(workspace.id, worker.id)).toBeUndefined()
        expect(server.store.listTerminalRuns(workspace.id)).toEqual([])
      }
    }
  },
  20_000
)
