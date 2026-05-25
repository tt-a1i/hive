import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'

const mockEnv = {
  HIVE_PORT: '9999',
  HIVE_PROJECT_ID: 'ws-001',
  HIVE_AGENT_ID: 'agent-001',
  HIVE_AGENT_TOKEN: 'tok-001',
}

const mockJsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('team task', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    Object.assign(process.env, mockEnv)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({ ok: true }))
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const key of Object.keys(mockEnv)) delete process.env[key]
  })

  test('task list calls GET /api/team/tasks with workspace_id', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse([{ id: '1', title: 'foo', status: 'open' }]))
    await runTeamCommand(['task', 'list'])
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/api/team/tasks?')
    expect(url).toContain('workspace_id=ws-001')
    expect(init.method).toBe('GET')
  })

  test('task list --status filters by status', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse([]))
    await runTeamCommand(['task', 'list', '--status', 'blocked'])
    const [url] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('status=blocked')
  })

  test('task show calls GET /api/team/tasks/:id', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({ id: 't-1', title: 'x' }))
    await runTeamCommand(['task', 'show', 't-1'])
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/api/team/tasks/t-1')
    expect(init.method).toBe('GET')
  })

  test('task show without id throws', async () => {
    await expect(runTeamCommand(['task', 'show'])).rejects.toThrow('Usage: team task show <id>')
  })

  test('task create posts title and workspace_id', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({ ok: true, task_id: 't-2', status: 'open' }))
    await runTeamCommand(['task', 'create', 'Fix', 'the', 'bug'])
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/api/team/tasks')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.title).toBe('Fix the bug')
    expect(body.workspace_id).toBe('ws-001')
  })

  test('task create without title throws', async () => {
    await expect(runTeamCommand(['task', 'create'])).rejects.toThrow(
      'Usage: team task create "<title>"'
    )
  })

  test('task done posts status=done', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({ ok: true, task_id: 't-3', status: 'done' }))
    await runTeamCommand(['task', 'done', 't-3'])
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/api/team/tasks/t-3/status')
    const body = JSON.parse(init.body as string)
    expect(body.status).toBe('done')
  })

  test('task block posts status=blocked', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({ ok: true, task_id: 't-4', status: 'blocked' }))
    await runTeamCommand(['task', 'block', 't-4'])
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/api/team/tasks/t-4/status')
    const body = JSON.parse(init.body as string)
    expect(body.status).toBe('blocked')
  })

  test('task cancel posts status=cancelled', async () => {
    fetchSpy.mockResolvedValue(
      mockJsonResponse({ ok: true, task_id: 't-5', status: 'cancelled' })
    )
    await runTeamCommand(['task', 'cancel', 't-5'])
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/api/team/tasks/t-5/status')
    const body = JSON.parse(init.body as string)
    expect(body.status).toBe('cancelled')
  })

  test('task done/block/cancel without id throws', async () => {
    await expect(runTeamCommand(['task', 'done'])).rejects.toThrow('Usage: team task done <id>')
    await expect(runTeamCommand(['task', 'block'])).rejects.toThrow('Usage: team task block <id>')
    await expect(runTeamCommand(['task', 'cancel'])).rejects.toThrow(
      'Usage: team task cancel <id>'
    )
  })

  test('unknown task subcommand throws', async () => {
    await expect(runTeamCommand(['task', 'yeet'])).rejects.toThrow(
      'Unknown task subcommand: yeet'
    )
  })
})

describe('team send --task / --create-task', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any

  beforeEach(() => {
    Object.assign(process.env, mockEnv)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockJsonResponse({ ok: true, dispatch_id: 'd-1' })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const key of Object.keys(mockEnv)) delete process.env[key]
  })

  test('--task attaches task_id to send payload', async () => {
    await runTeamCommand(['send', 'bob', 'do stuff', '--task', 't-10'])
    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.task_id).toBe('t-10')
    expect(body.to).toBe('bob')
    expect(body.text).toBe('do stuff')
  })

  test('--create-task sets create_task flag', async () => {
    await runTeamCommand(['send', 'bob', 'do stuff', '--create-task'])
    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.create_task).toBe(true)
    expect(body.task_id).toBeUndefined()
  })

  test('send without --task or --create-task omits both fields', async () => {
    await runTeamCommand(['send', 'bob', 'do stuff'])
    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.task_id).toBeUndefined()
    expect(body.create_task).toBeUndefined()
  })
})
