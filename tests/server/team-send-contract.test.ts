import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let cleanupServer: (() => Promise<void>) | undefined
const originalEnv = { ...process.env }

beforeEach(async () => {
  const server = await startTestServer()
  cleanupServer = server.close
  const uiCookie = await getUiCookie(server.baseUrl)

  const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alpha', path: '/tmp/hive-alpha' }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }

  process.env = {
    ...originalEnv,
    HIVE_AGENT_ID: `${workspace.id}:orchestrator`,
    HIVE_AGENT_TOKEN: 'dummy-token-for-arg-validation',
    HIVE_PORT: server.baseUrl.split(':').at(-1) ?? '',
    HIVE_PROJECT_ID: workspace.id,
  }

  await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
})

afterEach(async () => {
  process.env = { ...originalEnv }
  await cleanupServer?.()
  cleanupServer = undefined
})

describe('team send contract', () => {
  test('team send rejects direct worker id usage', async () => {
    await expect(
      runTeamCommand(['send', '123e4567-e89b-12d3-a456-426614174000', 'Implement login'])
    ).rejects.toThrow('Usage: team send <worker-name> <task>')
  })
})
