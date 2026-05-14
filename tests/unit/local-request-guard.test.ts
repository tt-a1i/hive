import type { IncomingMessage } from 'node:http'

import { describe, expect, test } from 'vitest'

import { getLocalRequestRejection } from '../../src/server/local-request-guard.js'

const requestWith = (input: { host?: string; origin?: string; remoteAddress?: string }) =>
  ({
    headers: {
      ...(input.host ? { host: input.host } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    },
    socket: {
      remoteAddress: input.remoteAddress,
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

  test('rejects non-local remote addresses before trusting local Host headers', () => {
    expect(
      getLocalRequestRejection(requestWith({ host: '127.0.0.1:5180', remoteAddress: '10.0.0.5' }))
    ).toBe('non-local remote address')
  })
})
