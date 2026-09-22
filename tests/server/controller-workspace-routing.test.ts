import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, onTestFinished, test } from 'vitest'
import { callHiveMcpTool } from '../../src/cli/hive-mcp.js'
import { HIVE_SUPERVISOR_TOKEN_HEADER } from '../../src/server/external-goal-auth.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

// Real servers and SQLite; no PTY is needed for read-only routing/404 behavior.
test('controller rejects foreign workspace IDs without creating workspaces on either runtime', async () => {
  const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
  onTestFinished(async () => {
    const results = await Promise.allSettled(servers.map((server) => server.close()))
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Fixture server cleanup failed')
  })
  for (let index = 0; index < 2; index++) servers.push(await startTestServer())
  const ids: string[] = []
  const tokens: string[] = []
  for (const server of servers) {
    const workspacePath = join(server.dataDir, 'workspace')
    mkdirSync(workspacePath)
    const created = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { cookie: await getUiCookie(server.baseUrl), 'content-type': 'application/json' },
      body: JSON.stringify({
        path: workspacePath,
        name: 'Routing fixture',
        autostart_orchestrator: false,
      }),
    })
    expect(created.status).toBe(201)
    ids.push(((await created.json()) as { id: string }).id)
    const session = await fetch(`${server.baseUrl}/api/external-goals/session`)
    expect(session.status).toBe(200)
    tokens.push(((await session.json()) as { token: string }).token)
  }
  expect(ids[0]).not.toBe(ids[1])
  const metadata = { threadId: randomUUID() }
  for (const [index, server] of servers.entries()) {
    const foreignId = ids[1 - index]
    const token = tokens[index]
    if (!token) throw new Error('Fixture did not receive a Supervisor credential')
    for (const path of ['/api/controller/request', '/api/controller/action']) {
      const response = await fetch(`${server.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HIVE_SUPERVISOR_TOKEN_HEADER]: token,
          'x-hive-controller-thread-id': metadata.threadId,
        },
        body: JSON.stringify({
          workspace_id: foreignId,
          ...(path.endsWith('/action') ? { action: 'inspect' } : {}),
        }),
      })
      expect(response.status).toBe(404)
    }
    const listed = (await callHiveMcpTool(
      'hive.list_workspaces',
      {},
      {
        env: { HIVE_PORT: new URL(server.baseUrl).port },
      }
    )) as { workspaces: Array<{ id: string }> }
    expect(listed.workspaces.map((workspace) => workspace.id)).toEqual([ids[index]])
  }
})
