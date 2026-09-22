// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'

import { startAgentRun } from '../../web/src/api.js'
import { directTransport } from '../../web/src/transport/direct-transport.js'
import {
  isGatewayServedBundle,
  shouldUseGatewayBundle,
} from '../../web/src/transport/select-transport.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DirectTransport.fetch — byte-for-behavior identical to global fetch', () => {
  // D1 — passes path + init through to the global fetch verbatim, returns the
  // response untouched. Fails if Direct rewrites the URL, drops init, or wraps
  // the body.
  test('forwards path and init to global fetch unchanged and returns the same Response', async () => {
    const expected = new Response('{"ok":true}', { status: 201 })
    const fetchMock = vi.fn(async () => expected)
    vi.stubGlobal('fetch', fetchMock)

    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    }
    const response = await directTransport.fetch('/api/workspaces', init)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', init)
    // Same Response instance — no re-wrapping / reassembly on the direct path.
    expect(response).toBe(expected)
    expect(response.status).toBe(201)
  })

  // D2 — the shared 403->refresh->retry in api.ts's apiFetch survives the
  // refactor and rides through activeTransport. A non-stale 403 is NOT retried.
  test('apiFetch refreshes the stale UI session once and retries through the transport', async () => {
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
        new Response(JSON.stringify({ run_id: 'run-refreshed' }), {
          headers: { 'content-type': 'application/json' },
          status: 201,
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(startAgentRun('workspace-1', 'workspace-1:orchestrator')).resolves.toEqual({
      runId: 'run-refreshed',
    })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspaces/workspace-1/agents/workspace-1:orchestrator/start',
      '/api/ui/session',
      '/api/workspaces/workspace-1/agents/workspace-1:orchestrator/start',
    ])
  })

  test('a non-stale 403 is surfaced without a session refresh or retry', async () => {
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: 'forbidden for another reason' }), {
          headers: { 'content-type': 'application/json' },
          status: 403,
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(startAgentRun('workspace-1', 'workspace-1:orchestrator')).rejects.toThrow()
    // One call only: no /api/ui/session refresh, no retry.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspaces/workspace-1/agents/workspace-1:orchestrator/start',
    ])
  })
})

describe('DirectTransport.openWebSocket — same URL today builds', () => {
  // D3 — the URL equals today's toWebSocketUrl output: ws/wss mirrors
  // http/https, query params appended in order. Fails on a hardcoded origin or
  // a missing wss upgrade.
  test('builds a ws URL from window.location with params appended', () => {
    const seen: string[] = []
    class CapturingSocket {
      readonly OPEN = 1
      readyState = 0
      constructor(readonly url: string) {
        seen.push(url)
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', CapturingSocket as never)

    directTransport.openWebSocket('/ws/terminal/run-1/io', { clientId: 'c-1', cols: 80, rows: 24 })

    const expected = new URL('/ws/terminal/run-1/io', window.location.href)
    expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:'
    expected.searchParams.set('clientId', 'c-1')
    expected.searchParams.set('cols', '80')
    expected.searchParams.set('rows', '24')

    expect(seen).toEqual([expected.toString()])
    // Loopback dev origin must produce a ws:// (not wss://) URL.
    expect(seen[0]?.startsWith('ws://')).toBe(true)
  })

  test('omits params whose value is undefined', () => {
    const seen: string[] = []
    class CapturingSocket {
      readonly OPEN = 1
      readyState = 0
      constructor(readonly url: string) {
        seen.push(url)
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', CapturingSocket as never)

    directTransport.openWebSocket('/ws/tasks/ws-1', { clientId: undefined })

    expect(seen[0]).not.toContain('clientId')
    expect(new URL(seen[0] ?? '').pathname).toBe('/ws/tasks/ws-1')
  })
})

describe('select-transport boot selection', () => {
  // The desktop (loopback) host must never be classified as the gateway bundle,
  // so DirectTransport stays the default with zero boot wiring.
  test('loopback hosts are never the gateway bundle', () => {
    expect(isGatewayServedBundle()).toBe(false)
  })

  test('an explicit direct bundle stays direct on a LAN address', () => {
    expect(shouldUseGatewayBundle('192.0.2.10', '0')).toBe(false)
  })

  test('an explicit gateway bundle stays gateway on a LAN address', () => {
    expect(shouldUseGatewayBundle('192.0.2.10', '1')).toBe(true)
  })

  test('an unmarked bundle keeps the safe host fallback', () => {
    expect(shouldUseGatewayBundle('192.0.2.10', undefined)).toBe(true)
    expect(shouldUseGatewayBundle('localhost', undefined)).toBe(false)
  })
})
