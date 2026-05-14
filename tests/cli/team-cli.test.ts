import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runTeamCommand } from '../../src/cli/team.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
let serverStore: Awaited<ReturnType<typeof startTestServer>>['store'] | undefined
let workerId = ''
const originalEnv = { ...process.env }

beforeEach(async () => {
  const server = await startTestServer()
  cleanupServer = server.close
  serverStore = server.store
  const uiSessionResponse = await fetch(`${server.baseUrl}/api/ui/session`)
  const uiCookie = uiSessionResponse.headers.get('set-cookie')
  if (!uiCookie) {
    throw new Error('Expected UI session cookie')
  }

  const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alpha', path: '/tmp/hive-alpha' }),
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
        command: '/bin/bash',
        args: ['-lc', `${process.execPath} -e "process.stdin.resume()"`],
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
        command: '/bin/bash',
        args: ['-lc', `${process.execPath} -e "process.stdin.resume()"`],
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
  workerId = ''
  await cleanupServer?.()
  cleanupServer = undefined
})

describe('team cli with real server', () => {
  test('team list prints snake_case payload from a real backend', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['list'])

    const output = logSpy.mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(output) as Array<{
      id: string
      last_output_line: string | null
      name: string
      pending_task_count: number
      role: string
      status: string
    }>

    expect(parsed).toEqual([
      {
        id: expect.any(String),
        last_output_line: null,
        name: 'Alice',
        pending_task_count: 0,
        role: 'coder',
        status: 'idle',
      },
    ])
    logSpy.mockRestore()
  })

  test('team send Alice reaches the real backend', async () => {
    if (!serverStore) {
      throw new Error('Expected test server store')
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['send', 'Alice', 'Implement login'])).resolves.toBeUndefined()
    const output = logSpy.mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(output) as { dispatch_id: string; ok: true }
    expect(parsed).toEqual({
      dispatch_id: expect.any(String),
      ok: true,
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
})
