import { afterEach, describe, expect, test, vi } from 'vitest'

import { createWorkspace, startAgentRun } from '../../web/src/api.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('api error messages', () => {
  test('createWorkspace preserves server JSON error detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Workspace path does not exist: /missing' }), {
            headers: { 'content-type': 'application/json' },
            status: 400,
          })
      )
    )

    await expect(createWorkspace({ name: 'Missing', path: '/missing' })).rejects.toThrow(
      'Workspace path does not exist: /missing'
    )
  })

  test('startAgentRun preserves server JSON error detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'claude CLI not found in PATH' }), {
            headers: { 'content-type': 'application/json' },
            status: 500,
          })
      )
    )

    await expect(startAgentRun('workspace-1', 'workspace-1:orchestrator')).rejects.toThrow(
      'claude CLI not found in PATH'
    )
  })

  test('startAgentRun refreshes stale UI session token and retries once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'UI endpoint requires valid UI token' }), {
          headers: { 'content-type': 'application/json' },
          status: 403,
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'run-after-session-refresh' }), {
          headers: { 'content-type': 'application/json' },
          status: 201,
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(startAgentRun('workspace-1', 'workspace-1:orchestrator')).resolves.toEqual({
      runId: 'run-after-session-refresh',
    })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspaces/workspace-1/agents/workspace-1:orchestrator/start',
      '/api/ui/session',
      '/api/workspaces/workspace-1/agents/workspace-1:orchestrator/start',
    ])
  })
})
