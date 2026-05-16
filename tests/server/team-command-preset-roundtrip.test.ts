import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const tempDirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const makeWorkspacePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-preset-roundtrip-'))
  tempDirs.push(dir)
  return dir
}

const createWorkspace = async (baseUrl: string, cookie: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: 'PresetTrip',
      path: makeWorkspacePath(),
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

interface TeamMember {
  id: string
  name: string
  command_preset_id: string | null
}

/**
 * End-to-end shape check: anything the wire actually carries between
 * `POST /workers` and `GET /team` must be exercised here. Without it, a
 * regression in either side (serializer, enrichment, deserializer, route
 * wiring) would silently drop `command_preset_id` and the worker card would
 * just fall back to the role-letter avatar — a visible but easy-to-miss
 * downgrade, especially in dev where caches mask the failure.
 */
describe('POST → GET round-trip carries command_preset_id end to end', () => {
  test('explicit `claude` preset on create flows into the GET /team payload as `claude`', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server.baseUrl, cookie)

    const createResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart: false,
        command_preset_id: 'claude',
        name: 'Alice',
        role: 'coder',
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as TeamMember
    expect(created.command_preset_id).toBe('claude')

    const teamResponse = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
      headers: { cookie },
    })
    expect(teamResponse.status).toBe(200)
    const team = (await teamResponse.json()) as TeamMember[]
    const alice = team.find((member) => member.id === created.id)
    expect(alice?.command_preset_id).toBe('claude')
  })

  test('worker created without a preset gets `command_preset_id: null` back on GET', async () => {
    // This is the canonical historical-data shape: the launch config row
    // never gets written, so resolveCommandPresetId returns null and the
    // wire field is null (not absent, not undefined). The frontend's
    // fromPayload then drops the key, and the UI falls back to RoleAvatar.
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server.baseUrl, cookie)

    const createResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart: false, name: 'Bob', role: 'reviewer' }),
    })
    expect(createResponse.status).toBe(201)

    const teamResponse = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
      headers: { cookie },
    })
    const team = (await teamResponse.json()) as TeamMember[]
    const bob = team.find((member) => member.name === 'Bob')
    expect(bob).toBeDefined()
    expect(bob?.command_preset_id).toBeNull()
  })
})
