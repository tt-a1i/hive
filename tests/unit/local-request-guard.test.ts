import type { IncomingMessage } from 'node:http'

import { describe, expect, test, vi } from 'vitest'

import { getLocalRequestRejection } from '../../src/server/local-request-guard.js'

const requestWith = (input: { host?: string; origin?: string; remoteAddress?: string }) =>
  ({
    headers: {
      ...(input.host ? { host: input.host } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    },
    socket: {
      remoteAddress: input.remoteAddress,
      localPort: 5180,
    },
  }) as IncomingMessage

describe('local request guard', () => {
  test('accepts localhost, loopback IPv4, and IPv4-mapped IPv6 clients', () => {
    expect(
      getLocalRequestRejection(requestWith({ host: 'localhost:5180', remoteAddress: '::1' }))
    ).toBeNull()
    expect(
      getLocalRequestRejection(requestWith({ host: '127.0.0.1:5180', remoteAddress: '127.0.0.1' }))
    ).toBeNull()
    expect(
      getLocalRequestRejection(
        requestWith({ host: '127.0.0.1:5180', remoteAddress: '::ffff:127.0.0.1' })
      )
    ).toBeNull()
  })

  test('accepts the configured development origin behind a proxy, and rejects other ports', () => {
    vi.stubEnv('HIVE_WEB_PORT', '5300')
    try {
      expect(
        getLocalRequestRejection(
          requestWith({
            host: '127.0.0.1:5180',
            origin: 'http://127.0.0.1:5300',
            remoteAddress: '127.0.0.1',
          })
        )
      ).toBeNull()
      expect(
        getLocalRequestRejection(
          requestWith({
            host: '127.0.0.1:5180',
            origin: 'http://127.0.0.1:5301',
            remoteAddress: '127.0.0.1',
          })
        )
      ).not.toBeNull()
      expect(
        getLocalRequestRejection(
          requestWith({ origin: 'http://127.0.0.1:5300', remoteAddress: '127.0.0.1' })
        )
      ).not.toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('rejects non-local remote addresses before trusting local Host headers', () => {
    expect(
      getLocalRequestRejection(requestWith({ host: '127.0.0.1:5180', remoteAddress: '10.0.0.5' }))
    ).toBe('non-local remote address')
  })
})
