import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runTeamCommand } from '../../src/cli/team.js'
import { CODER_ROLE_DESCRIPTION } from '../../src/server/role-templates.js'
import { WORKFLOW_ENABLED_KEY } from '../../src/server/workflow-feature.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
let serverStore: Awaited<ReturnType<typeof startTestServer>>['store'] | undefined
let workspacePath = ''
let workerId = ''
const originalEnv = { ...process.env }
const tempDirs: string[] = []

beforeEach(async () => {
  const server = await startTestServer()
  cleanupServer = server.close
  serverStore = server.store
  workspacePath = mkdtempSync(join(tmpdir(), 'hive-team-cli-alpha-'))
  tempDirs.push(workspacePath)
  // Workflows are an experimental opt-in (off by default); the `team workflow`
  // cases in this file exercise the happy path, so enable the feature.
  serverStore.settings.setAppState(WORKFLOW_ENABLED_KEY, 'true')
  const uiSessionResponse = await fetch(`${server.baseUrl}/api/ui/session`)
  const uiCookie = uiSessionResponse.headers.get('set-cookie')
  if (!uiCookie) {
    throw new Error('Expected UI session cookie')
  }

  const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }

  const orchestratorId = `${workspace.id}:orchestrator`
  process.env = {
    ...originalEnv,
    HIVE_AGENT_ID: orchestratorId,
    HIVE_AGENT_TOKEN: 'placeholder-replaced-after-start',
    HIVE_PORT: server.baseUrl.split(':').at(-1) ?? '',
    HIVE_PROJECT_ID: workspace.id,
  }

  await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })

  const configResponse = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${workspace.id}:orchestrator/config`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
      }),
    }
  )
  if (configResponse.status !== 204) {
    throw new Error(`Failed to configure orchestrator: ${await configResponse.text()}`)
  }

  const sessionResponse = await fetch(`${server.baseUrl}/api/ui/session`)
  const cookie = sessionResponse.headers.get('set-cookie')
  if (!cookie) {
    throw new Error('Expected UI session cookie')
  }
  const workerListResponse = await fetch(
    `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team`,
    {
      headers: { cookie },
    }
  )
  const workers = (await workerListResponse.json()) as Array<{ id: string; name: string }>
  const alice = workers.find((worker) => worker.name === 'Alice')
  if (!alice) {
    throw new Error('Expected Alice worker')
  }
  workerId = alice.id

  const workerConfigResponse = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${alice.id}/config`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
      }),
    }
  )
  if (workerConfigResponse.status !== 204) {
    throw new Error(`Failed to configure worker: ${await workerConfigResponse.text()}`)
  }

  await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${workspace.id}:orchestrator/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ hive_port: process.env.HIVE_PORT }),
    }
  )
  await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/agents/${alice.id}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ hive_port: process.env.HIVE_PORT }),
  })

  const token = server.store.peekAgentToken(orchestratorId)
  if (!token) {
    throw new Error('Expected orchestrator token after start')
  }
  process.env.HIVE_AGENT_TOKEN = token
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.env = { ...originalEnv }
  serverStore = undefined
  workspacePath = ''
  workerId = ''
  await cleanupServer?.()
  cleanupServer = undefined
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('team cli with real server', () => {
  test('team list prints snake_case payload from a real backend', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['list'])

    const output = logSpy.mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(output) as Array<{
      command_preset_id: string | null
      id: string
      last_pty_line: string | null
      name: string
      pending_task_count: number
      role: string
      status: string
    }>

    expect(parsed).toEqual([
      {
        command_preset_id: null,
        configured_command: process.execPath,
        configured_model: null,
        description: CODER_ROLE_DESCRIPTION,
        id: expect.any(String),
        last_pty_line: null,
        name: 'Alice',
        pending_task_count: 0,
        role: 'coder',
        startup_ready_at: expect.any(Number),
        status: 'idle',
      },
    ])
    logSpy.mockRestore()
  })

  test('team next returns only the unblocked tasks from .hive/tasks.md', async () => {
    const tasksPath = join(workspacePath, '.hive', 'tasks.md')
    mkdirSync(dirname(tasksPath), { recursive: true })
    writeFileSync(
      tasksPath,
      ['- [x] design', '- [ ] build [needs: #1]', '- [ ] ship [needs: #2]'].join('\n'),
      'utf8'
    )

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runTeamCommand(['next'])
    const payload = JSON.parse((logSpy.mock.calls.at(-1)?.[0] as string) ?? '{}') as {
      tasks: Array<{ index: number; text: string }>
    }
    logSpy.mockRestore()

    // #1 is done so #2 'build' is unblocked; #3 'ship' still waits on #2.
    expect(payload.tasks).toEqual([{ index: 2, text: 'build' }])
  })

  test('team send Alice reaches the real backend', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['send', 'Alice', 'Implement login'])).resolves.toBeUndefined()
    const output = logSpy.mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(output) as {
      dispatch_id: string
      ok: true
      restarted_worker: boolean
    }
    expect(parsed).toEqual({
      dispatch_id: expect.any(String),
      parent_dispatch_id: null,
      root_dispatch_id: parsed.dispatch_id,
      ok: true,
      // beforeEach started Alice's PTY explicitly, so she was active
      // at dispatch time — no auto-wake happened. The flag is on the
      // wire shape regardless; only its value tracks the wake event.
      restarted_worker: false,
    })
    logSpy.mockRestore()

    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }

    const worker = serverStore.getWorker(workspaceId, workerId)
    expect(worker.pendingTaskCount).toBe(1)
    expect(worker.status).toBe('working')
    expect(serverStore.listMessagesForRecovery(workspaceId, 0)).toContainEqual(
      expect.objectContaining({ type: 'send', to: workerId, text: 'Implement login' })
    )
  })

  test('team send allows a worker name that looks like a UUID', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }
    const uuidLikeName = '123e4567-e89b-42d3-a456-426614174000'
    const worker = serverStore.addWorker(workspaceId, { name: uuidLikeName, role: 'coder' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['send', uuidLikeName, 'Queue this by exact name'])
    logSpy.mockRestore()

    expect(serverStore.listMessagesForRecovery(workspaceId, 0)).toContainEqual(
      expect.objectContaining({
        text: 'Queue this by exact name',
        to: worker.id,
        type: 'send',
      })
    )
    expect(serverStore.getWorker(workspaceId, worker.id)).toMatchObject({
      pendingTaskCount: 1,
      status: 'stopped',
    })
  })

  test('team recall finds report evidence through the real CLI and server path', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['send', 'Alice', '调查远程访问链路'])
    const sendPayload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}') as {
      dispatch_id: string
    }
    const workerToken = serverStore.peekAgentToken(workerId)
    if (!workerToken) {
      throw new Error('Expected worker token after start')
    }
    process.env.HIVE_AGENT_ID = workerId
    process.env.HIVE_AGENT_TOKEN = workerToken

    await runTeamCommand([
      'report',
      '远程访问链路已恢复，移动端 E2E relay 正常',
      '--dispatch',
      sendPayload.dispatch_id,
    ])
    logSpy.mockClear()

    await runTeamCommand(['recall', '访问链', '--limit', '5', '--window', '1'])
    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}') as {
      ok: true
      results: Array<{
        context: Array<{ text: string; type: string }>
        message_type: string | null
        report_text: string | null
        source_type: string
        text: string
      }>
    }
    logSpy.mockRestore()

    expect(payload.ok).toBe(true)
    expect(payload.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message_type: 'report',
          source_type: 'message',
          text: '远程访问链路已恢复，移动端 E2E relay 正常',
        }),
        expect.objectContaining({
          report_text: '远程访问链路已恢复，移动端 E2E relay 正常',
          source_type: 'dispatch',
        }),
      ])
    )
    const reportHit = payload.results.find(
      (result) => result.source_type === 'message' && result.message_type === 'report'
    )
    expect(
      reportHit?.context.some((item) => item.type === 'send' && item.text === '调查远程访问链路')
    ).toBe(true)
  })

  test('team cancel --dispatch closes the selected dispatch', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['send', 'Alice', 'Front-end scan'])
    const output = logSpy.mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(output) as { dispatch_id: string; ok: true }
    logSpy.mockRestore()

    await runTeamCommand([
      'cancel',
      '--dispatch',
      parsed.dispatch_id,
      'Direction changed; front-end scan is no longer needed',
    ])

    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }
    expect(serverStore.listDispatches(workspaceId)).toEqual([
      expect.objectContaining({
        id: parsed.dispatch_id,
        reportText: 'Direction changed; front-end scan is no longer needed',
        status: 'cancelled',
      }),
    ])
    expect(serverStore.getWorker(workspaceId, workerId)).toMatchObject({
      pendingTaskCount: 0,
      status: 'idle',
    })
  })

  test('team send joins unquoted task words instead of silently truncating', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['send', 'Alice', 'Implement', 'multi', 'word', 'task'])
    logSpy.mockRestore()

    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }
    expect(serverStore.listMessagesForRecovery(workspaceId, 0)).toContainEqual(
      expect.objectContaining({
        type: 'send',
        to: workerId,
        text: 'Implement multi word task',
      })
    )
  })

  test('team report rejects an orchestrator token with the server error detail', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }

    await expect(runTeamCommand(['report', 'orchestrator should not report'])).rejects.toThrow(
      "Request failed with status 403: Role 'orchestrator' is not allowed to run team report"
    )

    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }

    expect(
      serverStore.listMessagesForRecovery(workspaceId, 0).filter((item) => item.type === 'report')
    ).toEqual([])
  })

  test('team report --dispatch reports the selected open dispatch', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['send', 'Alice', 'First task'])
    await runTeamCommand(['send', 'Alice', 'Second task'])
    const firstDispatch = JSON.parse(logSpy.mock.calls[0]?.[0] ?? '{}') as {
      dispatch_id: string
    }
    const secondDispatch = JSON.parse(logSpy.mock.calls[1]?.[0] ?? '{}') as {
      dispatch_id: string
    }
    logSpy.mockRestore()

    const workerToken = serverStore.peekAgentToken(workerId)
    if (!workerToken) {
      throw new Error('Expected worker token after start')
    }
    process.env.HIVE_AGENT_ID = workerId
    process.env.HIVE_AGENT_TOKEN = workerToken

    await runTeamCommand(['report', 'Second done', '--dispatch', secondDispatch.dispatch_id])

    const workspaceId = process.env.HIVE_PROJECT_ID
    if (!workspaceId) {
      throw new Error('Expected workspace id')
    }

    expect(serverStore.listDispatches(workspaceId)).toEqual([
      expect.objectContaining({
        id: firstDispatch.dispatch_id,
        reportText: null,
        status: 'submitted',
      }),
      expect.objectContaining({
        id: secondDispatch.dispatch_id,
        reportText: 'Second done',
        status: 'reported',
      }),
    ])
    expect(serverStore.getWorker(workspaceId, workerId)).toMatchObject({
      pendingTaskCount: 1,
      status: 'working',
    })
  })

  test('team list surfaces 403 when a worker token is used', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const workerToken = serverStore.peekAgentToken(workerId)
    if (!workerToken) {
      throw new Error('Expected worker token after start')
    }

    process.env.HIVE_AGENT_ID = workerId
    process.env.HIVE_AGENT_TOKEN = workerToken

    await expect(runTeamCommand(['list'])).rejects.toThrow('Request failed with status 403')
  })

  test('team list explains when the Hive runtime cannot be reached', async () => {
    process.env.HIVE_PORT = '9'

    await expect(runTeamCommand(['list'])).rejects.toThrow(
      'Failed to reach Hive runtime at http://127.0.0.1:9'
    )
  })

  test('team workflow run --args parses JSON and threads it into the run (TIER 2 #8)', async () => {
    /* Regression for TIER 2 #8: the runner exposed `args` as the 7th DSL
       global, but `team workflow run` had no `--args` flag so the
       orchestrator-driven path couldn't set it. Saved workflows would
       always see `args === undefined`. */
    if (!serverStore) throw new Error('Expected test server store')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runTeamCommand([
        'workflow',
        'run',
        '--inline',
        "export const meta = { name: 'echo-args', description: 'd' }\nreturn args",
        '--args',
        '{"files":["a.ts","b.ts"]}',
      ])
      const lastCall = logSpy.mock.calls.at(-1)?.[0]
      expect(typeof lastCall).toBe('string')
      const payload = JSON.parse(String(lastCall)) as { ok: boolean; run_id: string }
      expect(payload.ok).toBe(true)
      // Poll until the inline run terminates (background execution).
      const deadline = Date.now() + 3000
      let final = serverStore.getWorkflowRun(payload.run_id)
      while (final && final.status === 'running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
        final = serverStore.getWorkflowRun(payload.run_id)
      }
      expect(final?.status).toBe('completed')
      // The return value was `args`, so result must be the parsed JSON.
      expect(final?.result).toEqual({ files: ['a.ts', 'b.ts'] })
    } finally {
      logSpy.mockRestore()
    }
  })

  test('team workflow run --args rejects invalid JSON locally before the round-trip (TIER 2 #8)', async () => {
    /* The CLI parses --args eagerly so a typo gives a clear local
       error, not a 400 from the server. */
    await expect(
      runTeamCommand([
        'workflow',
        'run',
        '--inline',
        "export const meta = { name: 'x', description: 'd' }\nreturn 1",
        '--args',
        '{not-json',
      ])
    ).rejects.toThrow(/must be valid JSON/)
  })
})
