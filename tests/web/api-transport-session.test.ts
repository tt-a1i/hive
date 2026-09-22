// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'

import { initializeUiSession, setApiTransport, startAgentRun } from '../../web/src/api.js'
import type { ApiTransport, TransportSocket } from '../../web/src/transport/api-transport.js'
import { directTransport } from '../../web/src/transport/direct-transport.js'

const closedSocket = (): TransportSocket => ({
  OPEN: 1,
  readyState: 3,
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  send: () => {
    throw new Error('socket is closed')
  },
  close: () => {},
})

const tunnelLikeTransport = (fetch: ApiTransport['fetch']): ApiTransport => ({
  requiresUiSession: false,
  fetch,
  openWebSocket: () => closedSocket(),
})

afterEach(() => {
  setApiTransport(directTransport)
  vi.restoreAllMocks()
})

describe('api transport UI session bootstrap', () => {
  test('tunnel transports skip the desktop UI session bootstrap', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('unexpected fetch')
    })
    setApiTransport(tunnelLikeTransport(fetch))

    await expect(initializeUiSession()).resolves.toBeUndefined()

    expect(fetch).not.toHaveBeenCalled()
  })

  test('tunnel transports do not refresh desktop UI session tokens on 403', async () => {
    const fetch = vi.fn<ApiTransport['fetch']>(
      async () =>
        new Response(JSON.stringify({ error: 'UI endpoint requires valid UI token' }), {
          headers: { 'content-type': 'application/json' },
          status: 403,
        })
    )
    setApiTransport(tunnelLikeTransport(fetch))

    await expect(startAgentRun('workspace-1', 'worker-1')).rejects.toThrow(
      'UI endpoint requires valid UI token'
    )

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/workspaces/workspace-1/agents/worker-1/start',
    ])
  })
})
