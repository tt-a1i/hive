import { describe, expect, test, vi } from 'vitest'

import { createWebhookNotifier, type WebhookEvent } from '../../src/server/webhook-notifier.js'

const event: WebhookEvent = {
  type: 'report_received',
  workspaceId: 'ws-1',
  agentName: 'Alice',
  summary: 'fixed login',
  at: 1234,
}

describe('webhook notifier', () => {
  test('POSTs the event JSON to the configured URL', () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 200 }))
    )
    const { notify } = createWebhookNotifier({
      getUrl: () => 'https://hooks.example.com/hive',
      fetchImpl,
    })

    notify(event)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const request = fetchImpl.mock.calls[0]
    if (!request?.[1]) throw new Error('Expected webhook request with options')
    const [url, init] = request
    expect(url).toBe('https://hooks.example.com/hive')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual(event)
  })

  test('does nothing when no URL is configured', () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response()))
    const { notify } = createWebhookNotifier({ getUrl: () => null, fetchImpl: fetchImpl as never })

    notify(event)
    notify({ ...event, type: 'agent_stopped' })

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('refuses a non-http(s) URL', () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response()))
    const { notify } = createWebhookNotifier({
      getUrl: () => 'file:///etc/passwd',
      fetchImpl: fetchImpl as never,
    })

    notify(event)

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('swallows a failing webhook without throwing', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('connection refused')))
    const { notify } = createWebhookNotifier({
      getUrl: () => 'http://127.0.0.1:9999/ntfy',
      fetchImpl: fetchImpl as never,
    })

    notify(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
