import { afterEach, expect, test } from 'vitest'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

test('HTTP accepts its own origin and JSON, and rejects a different port and non-JSON body', async () => {
  const server = await startTestServer()
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const endpoint = `${server.baseUrl}/api/settings/app-state/active_workspace_id`
  const send = (origin: string, type: string) =>
    fetch(endpoint, {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': type },
      body: JSON.stringify({ value: null }),
    })
  expect((await send(server.baseUrl, 'application/json; charset=utf-8')).status).toBe(204)
  const other = new URL(server.baseUrl)
  other.port = other.port === '65535' ? '65534' : String(Number(other.port) + 1)
  expect((await send(other.origin, 'application/json')).status).toBe(403)
  expect((await send(server.baseUrl, 'text/plain')).status).toBe(415)
})

test('optional pairing confirmation accepts absent or malformed JSON as before and rejects unsupported body types', async () => {
  const server = await startTestServer()
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const endpoint = `${server.baseUrl}/api/remote/pairings/missing/confirm`
  const empty = await fetch(endpoint, { method: 'POST', headers: { cookie } })
  const malformed = await fetch(endpoint, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{',
  })
  const unsupported = await fetch(endpoint, {
    method: 'POST',
    headers: { cookie, 'content-type': 'text/plain' },
    body: '{}',
  })
  expect(empty.status).toBe(404)
  expect(malformed.status).toBe(404)
  expect(unsupported.status).toBe(415)
})
