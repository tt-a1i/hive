import { describe, expect, test } from 'vitest'

import {
  HIVE_REMOTE_DEVICE_HEADER,
  HIVE_REMOTE_SECRET_HEADER,
  isTunnelDroppedRequestHeader,
  isTunnelStrippedResponseHeader,
  sanitizeTunnelResponseHeaders,
  stampLoopbackHeaders,
} from '../../src/server/remote-loopback-auth.js'

describe('stampLoopbackHeaders', () => {
  test('sets the secret + device headers from a record', () => {
    const out = stampLoopbackHeaders({ accept: 'application/json' }, 'sekret', 'device-1')
    expect(out.accept).toBe('application/json')
    expect(out[HIVE_REMOTE_SECRET_HEADER]).toBe('sekret')
    expect(out[HIVE_REMOTE_DEVICE_HEADER]).toBe('device-1')
  })

  test('accepts the M1 header list ([name, value] pairs)', () => {
    const out = stampLoopbackHeaders(
      [
        ['content-type', 'application/json'],
        ['accept-language', 'en'],
      ],
      'sekret',
      'device-2'
    )
    expect(out['content-type']).toBe('application/json')
    expect(out['accept-language']).toBe('en')
    expect(out[HIVE_REMOTE_SECRET_HEADER]).toBe('sekret')
    expect(out[HIVE_REMOTE_DEVICE_HEADER]).toBe('device-2')
  })

  test('drops all incoming internal headers before stamping trusted identity', () => {
    const out = stampLoopbackHeaders(
      [
        ['X-Hive-Extra', 'external'],
        ['X-Hive-Remote-Device', 'wrong'],
        ['accept', 'application/json'],
      ],
      'trusted-secret',
      'trusted-device'
    )
    expect(out).toEqual({
      accept: 'application/json',
      [HIVE_REMOTE_SECRET_HEADER]: 'trusted-secret',
      [HIVE_REMOTE_DEVICE_HEADER]: 'trusted-device',
    })
  })

  test('strips any client-supplied copy of BOTH tunnel headers (spoof defense)', () => {
    // A phone must not be able to spoof the device tag or smuggle a guessed
    // secret — we drop its copies and stamp ours, regardless of casing.
    const out = stampLoopbackHeaders(
      {
        [HIVE_REMOTE_SECRET_HEADER]: 'attacker-guess',
        'X-Hive-Remote-Device': 'spoofed-device',
        'X-Hive-Remote-Secret': 'another-guess',
        accept: 'text/plain',
      },
      'real-secret',
      'real-device'
    )
    expect(out.accept).toBe('text/plain')
    expect(out[HIVE_REMOTE_SECRET_HEADER]).toBe('real-secret')
    expect(out[HIVE_REMOTE_DEVICE_HEADER]).toBe('real-device')
    // no leftover spoofed copies under any casing
    expect(out['X-Hive-Remote-Device']).toBeUndefined()
    expect(out['X-Hive-Remote-Secret']).toBeUndefined()
    expect(Object.values(out)).not.toContain('spoofed-device')
    expect(Object.values(out)).not.toContain('attacker-guess')
    expect(Object.values(out)).not.toContain('another-guess')
  })

  // VULN-LOOPBACK-1: request-side smuggling. Before the fix stampLoopbackHeaders was a strip-2
  // blocklist — every other phone-supplied header (Host / Origin / Cookie / X-Forwarded-* /
  // Content-Length / Transfer-Encoding / hop-by-hop) flowed verbatim onto the 127.0.0.1 request.
  test('drops phone-supplied Host/Origin/Cookie so they never reach the loopback (VULN-LOOPBACK-1)', () => {
    const out = stampLoopbackHeaders(
      [
        ['Host', 'evil.com'],
        ['Origin', 'http://evil.com'],
        ['Cookie', 'hive_ui_token=guess'],
        ['content-type', 'application/json'],
        ['accept', 'application/json'],
      ],
      'real-secret',
      'real-device'
    )
    // The three smuggling vectors are gone…
    expect(out.Host).toBeUndefined()
    expect(out.host).toBeUndefined()
    expect(out.Origin).toBeUndefined()
    expect(out.origin).toBeUndefined()
    expect(out.Cookie).toBeUndefined()
    expect(out.cookie).toBeUndefined()
    expect(Object.values(out)).not.toContain('evil.com')
    expect(Object.values(out)).not.toContain('http://evil.com')
    expect(Object.values(out)).not.toContain('hive_ui_token=guess')
    // …but the few request headers the loopback legitimately needs survive, plus our stamp wins.
    expect(out['content-type']).toBe('application/json')
    expect(out.accept).toBe('application/json')
    expect(out[HIVE_REMOTE_SECRET_HEADER]).toBe('real-secret')
    expect(out[HIVE_REMOTE_DEVICE_HEADER]).toBe('real-device')
  })

  test('drops hop-by-hop, content-length, transfer-encoding and x-forwarded-* (VULN-LOOPBACK-1)', () => {
    const out = stampLoopbackHeaders(
      [
        ['Connection', 'keep-alive'],
        ['Transfer-Encoding', 'chunked'],
        ['Content-Length', '999999'],
        ['X-Forwarded-For', '10.0.0.1'],
        ['X-Forwarded-Host', 'evil.com'],
        ['Upgrade-Insecure-Requests', '1'],
        ['accept-language', 'en'],
      ],
      'sekret',
      'device-9'
    )
    expect(out.Connection).toBeUndefined()
    expect(out['Transfer-Encoding']).toBeUndefined()
    expect(out['Content-Length']).toBeUndefined()
    expect(out['X-Forwarded-For']).toBeUndefined()
    expect(out['X-Forwarded-Host']).toBeUndefined()
    expect(Object.values(out)).not.toContain('10.0.0.1')
    expect(Object.values(out)).not.toContain('999999')
    // a benign header still rides through
    expect(out['accept-language']).toBe('en')
    expect(out[HIVE_REMOTE_SECRET_HEADER]).toBe('sekret')
  })

  test('isTunnelDroppedRequestHeader classifies the smuggling vectors', () => {
    for (const h of [
      'host',
      'Host',
      'origin',
      'cookie',
      'content-length',
      'transfer-encoding',
      'connection',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-hive-remote-secret',
      'x-hive-remote-device',
    ]) {
      expect(isTunnelDroppedRequestHeader(h)).toBe(true)
    }
    for (const h of ['content-type', 'accept', 'accept-language', 'user-agent', 'range']) {
      expect(isTunnelDroppedRequestHeader(h)).toBe(false)
    }
  })
})

describe('sanitizeTunnelResponseHeaders (HARDEN response-header policy)', () => {
  test('strips Set-Cookie so the master UI token never reaches a device', () => {
    const head: Array<[string, string]> = [
      ['content-type', 'application/json'],
      ['set-cookie', 'hive_ui_token=secret; HttpOnly'],
    ]
    const out = sanitizeTunnelResponseHeaders(head)
    expect(out).toEqual([['content-type', 'application/json']])
  })

  test('Set-Cookie is stripped regardless of casing', () => {
    for (const name of ['Set-Cookie', 'SET-COOKIE', 'set-cookie', 'Set-Cookie2']) {
      const out = sanitizeTunnelResponseHeaders([
        [name, 'x=y'],
        ['etag', 'abc'],
      ])
      expect(out).toEqual([['etag', 'abc']])
    }
  })

  test('strips any internal x-hive-* header (current + future)', () => {
    const out = sanitizeTunnelResponseHeaders([
      ['x-hive-remote-device', 'device-1'],
      ['x-hive-internal-anything', 'leak'],
      ['x-frame-options', 'DENY'],
    ])
    // x-hive-* gone; an unrelated security header survives
    expect(out).toEqual([['x-frame-options', 'DENY']])
  })

  test('strips hop-by-hop headers meaningless across the mux boundary', () => {
    const out = sanitizeTunnelResponseHeaders([
      ['connection', 'keep-alive'],
      ['transfer-encoding', 'chunked'],
      ['content-type', 'text/html'],
    ])
    expect(out).toEqual([['content-type', 'text/html']])
  })

  test('keeps ordinary response headers untouched', () => {
    const head: Array<[string, string]> = [
      ['content-type', 'application/json'],
      ['content-length', '42'],
      ['cache-control', 'no-store'],
    ]
    expect(sanitizeTunnelResponseHeaders(head)).toEqual(head)
  })

  test('isTunnelStrippedResponseHeader classifies correctly', () => {
    expect(isTunnelStrippedResponseHeader('set-cookie')).toBe(true)
    expect(isTunnelStrippedResponseHeader('Set-Cookie')).toBe(true)
    expect(isTunnelStrippedResponseHeader('x-hive-remote-device')).toBe(true)
    expect(isTunnelStrippedResponseHeader('connection')).toBe(true)
    expect(isTunnelStrippedResponseHeader('content-type')).toBe(false)
    expect(isTunnelStrippedResponseHeader('etag')).toBe(false)
  })
})
