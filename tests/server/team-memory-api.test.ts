import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let server: Awaited<ReturnType<typeof startTestServer>> | undefined
let cookie = ''
let workspaceId = ''
let orchestratorId = ''
let orchestratorToken = ''
let workerId = ''
let workerToken = ''
const tempDirs: string[] = []

const createWorkspace = async (name: string) => {
  if (!server) throw new Error('Expected test server')
  const workspacePath = mkdtempSync(join(tmpdir(), 'hive-team-memory-api-'))
  tempDirs.push(workspacePath)
  const response = await fetch(`${server.baseUrl}/api/workspaces`, {
    body: JSON.stringify({ autostart_orchestrator: false, name, path: workspacePath }),
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  })
  const workspace = (await response.json()) as { id: string }
  return workspace.id
}

const configureAndStartAgent = async (agentId: string, workspace: string) => {
  if (!server) throw new Error('Expected test server')
  await fetch(`${server.baseUrl}/api/workspaces/${workspace}/agents/${agentId}/config`, {
    body: JSON.stringify({
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
    }),
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  })
  const startResponse = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace}/agents/${agentId}/start`,
    {
      body: JSON.stringify({ hive_port: server.baseUrl.split(':').at(-1) ?? '' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    }
  )
  expect(startResponse.status).toBe(201)
  const token = server.store.peekAgentToken(agentId)
  if (!token) throw new Error(`Expected token for ${agentId}`)
  return token
}

const addWorker = async (workspace: string) => {
  if (!server) throw new Error('Expected test server')
  const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace}/workers`, {
    body: JSON.stringify({ autostart: false, name: 'Alice', role: 'coder' }),
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  })
  const worker = (await response.json()) as { id: string }
  return worker.id
}

beforeEach(async () => {
  server = await startTestServer()
  cookie = await getUiCookie(server.baseUrl)
  workspaceId = await createWorkspace('Alpha')
  orchestratorId = `${workspaceId}:orchestrator`
  orchestratorToken = await configureAndStartAgent(orchestratorId, workspaceId)
  workerId = await addWorker(workspaceId)
  workerToken = await configureAndStartAgent(workerId, workspaceId)
})

afterEach(async () => {
  await server?.close()
  server = undefined
  cookie = ''
  workspaceId = ''
  orchestratorId = ''
  orchestratorToken = ''
  workerId = ''
  workerToken = ''
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const postMemory = (path: 'add' | 'forget' | 'search' | 'show', body: unknown) => {
  if (!server) throw new Error('Expected test server')
  return fetch(`${server.baseUrl}/api/team/memory/${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

describe('/api/team/memory add/show/search/forget', () => {
  test('decision supersession is atomic, attributable and restricted to the workspace orchestrator', async () => {
    const identity = {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
    }
    const originalResponse = await postMemory('add', {
      ...identity,
      body: 'Use SQLite for storage.',
      kind: 'decision',
    })
    expect(originalResponse.status).toBe(200)
    const { memory: original } = await originalResponse.json()
    const replacement = {
      body: 'Use PostgreSQL for storage.',
      kind: 'decision',
      supersedes_id: original.id,
    }
    expect(
      (
        await postMemory('add', {
          ...identity,
          ...replacement,
          from_agent_id: workerId,
          token: workerToken,
        })
      ).status
    ).toBe(403)
    expect((await postMemory('add', { ...identity, ...replacement, kind: 'fact' })).status).toBe(
      400
    )
    const otherWorkspaceId = await createWorkspace('Other')
    const otherOrchestratorId = `${otherWorkspaceId}:orchestrator`
    const otherToken = await configureAndStartAgent(otherOrchestratorId, otherWorkspaceId)
    expect(
      (
        await postMemory('add', {
          ...replacement,
          project_id: otherWorkspaceId,
          from_agent_id: otherOrchestratorId,
          token: otherToken,
        })
      ).status
    ).toBe(409)
    expect(server?.store.getMemoryEntry(workspaceId, original.id)?.status).toBe('active')
    const replacedResponse = await postMemory('add', { ...identity, ...replacement })
    expect(replacedResponse.status).toBe(200)
    const { memory: replaced } = await replacedResponse.json()
    expect(replaced.status).toBe('active')
    expect(replaced.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_type: 'memory',
          source_id: original.id,
          actor_agent_id_snapshot: orchestratorId,
        }),
      ])
    )
    expect(server?.store.getMemoryEntry(workspaceId, original.id)).toMatchObject({
      status: 'archived',
      body: 'Use SQLite for storage.',
    })
    expect((await postMemory('add', { ...identity, ...replacement })).status).toBe(409)
    expect(
      server?.store.searchMemoryEntries(workspaceId, 'storage').map((memory) => memory.id)
    ).toEqual([replaced.id])
  }, 30000)

  test('orchestrator add becomes active and show returns source actor snapshots', async () => {
    const addResponse = await postMemory('add', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      body: 'Remote mobile API calls must use the E2E relay path.',
      kind: 'decision',
      procedure_ref: { id: 'remote-release', title: 'Remote release', type: 'workflow' },
      tags: ['remote', 'relay'],
    })

    expect(addResponse.status).toBe(200)
    const addPayload = (await addResponse.json()) as {
      memory: {
        id: string
        body: string
        kind: string
        sources: Array<{
          actor_agent_id_snapshot: string
          actor_name_snapshot: string
          actor_role_snapshot: string
        }>
        status: string
        tags: string[]
        procedure_ref: { id: string; title: string | null; type: string } | null
        workspace_id: string
      }
      ok: true
    }
    expect(addPayload.memory).toMatchObject({
      body: 'Remote mobile API calls must use the E2E relay path.',
      kind: 'decision',
      procedure_ref: { id: 'remote-release', title: 'Remote release', type: 'workflow' },
      status: 'active',
      tags: ['remote', 'relay'],
      workspace_id: workspaceId,
    })
    expect(addPayload.memory.sources[0]).toMatchObject({
      actor_agent_id_snapshot: orchestratorId,
      actor_name_snapshot: 'Orchestrator',
      actor_role_snapshot: 'orchestrator',
    })

    const showResponse = await postMemory('show', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      memory_id: addPayload.memory.id,
    })

    expect(showResponse.status).toBe(200)
    await expect(showResponse.json()).resolves.toEqual({
      memory: expect.objectContaining({
        id: addPayload.memory.id,
        status: 'active',
        sources: expect.arrayContaining([
          expect.objectContaining({
            actor_agent_id_snapshot: orchestratorId,
            actor_role_snapshot: 'orchestrator',
          }),
        ]),
      }),
      ok: true,
    })
  })

  test('procedure_ref memory requires structured procedure_ref payload', async () => {
    const addResponse = await postMemory('add', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      body: 'Use the release checklist workflow.',
      kind: 'procedure_ref',
    })

    expect(addResponse.status).toBe(400)
    await expect(addResponse.json()).resolves.toEqual({
      error: 'procedure_ref is required when kind is procedure_ref',
    })
  })

  test('user-scoped memory is explicit and only appears in all-scope search', async () => {
    const addResponse = await postMemory('add', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      body: 'Prefer compact release checklists.',
      kind: 'preference',
      scope: 'user',
    })

    expect(addResponse.status).toBe(200)
    const addPayload = (await addResponse.json()) as { memory: { id: string } }

    const workspaceSearch = await postMemory('search', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      query: 'compact release',
    })
    expect(workspaceSearch.status).toBe(200)
    await expect(workspaceSearch.json()).resolves.toEqual({ ok: true, results: [] })

    const allScopeSearch = await postMemory('search', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      query: 'compact release',
      scope: 'all',
    })
    expect(allScopeSearch.status).toBe(200)
    await expect(allScopeSearch.json()).resolves.toEqual({
      ok: true,
      results: [expect.objectContaining({ id: addPayload.memory.id, scope: 'user' })],
    })
  })

  test('worker add is forbidden and cross-workspace show does not leak memory', async () => {
    const workerAddResponse = await postMemory('add', {
      project_id: workspaceId,
      from_agent_id: workerId,
      token: workerToken,
      body: 'The setup script fails if pnpm is missing.',
      kind: 'pitfall',
      tags: ['setup'],
    })
    expect(workerAddResponse.status).toBe(403)
    await expect(workerAddResponse.json()).resolves.toEqual({ error: expect.any(String) })

    const addResponse = await postMemory('add', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      body: 'The setup script fails if pnpm is missing.',
      kind: 'pitfall',
      tags: ['setup'],
    })
    const payload = (await addResponse.json()) as { memory: { id: string; status: string } }
    expect(addResponse.status).toBe(200)
    expect(payload.memory.status).toBe('active')

    const otherWorkspaceId = await createWorkspace('Beta')
    const otherOrchestratorId = `${otherWorkspaceId}:orchestrator`
    const otherToken = await configureAndStartAgent(otherOrchestratorId, otherWorkspaceId)
    const showResponse = await postMemory('show', {
      project_id: otherWorkspaceId,
      from_agent_id: otherOrchestratorId,
      token: otherToken,
      memory_id: payload.memory.id,
    })

    expect(showResponse.status).toBe(404)
    const showBody = (await showResponse.json()) as { error?: unknown }
    expect(showBody).toEqual({ error: expect.any(String) })
  })

  test('search is available to workers and forget is orchestrator-only archive', async () => {
    const addResponse = await postMemory('add', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      body: 'Remote mobile API calls must use the E2E relay path.',
      kind: 'decision',
      tags: ['remote', 'relay'],
    })
    const addPayload = (await addResponse.json()) as { memory: { id: string } }
    const cjkAddResponse = await postMemory('add', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      body: '移动端访问链必须经过 relay。',
      kind: 'pitfall',
      tags: ['访问链'],
    })
    const cjkPayload = (await cjkAddResponse.json()) as { memory: { id: string } }

    const workerSearchResponse = await postMemory('search', {
      project_id: workspaceId,
      from_agent_id: workerId,
      token: workerToken,
      query: 'remote relay',
    })
    expect(workerSearchResponse.status).toBe(200)
    await expect(workerSearchResponse.json()).resolves.toEqual({
      ok: true,
      results: [
        expect.objectContaining({
          body: 'Remote mobile API calls must use the E2E relay path.',
          id: addPayload.memory.id,
          index_name: expect.any(String),
          sources: expect.arrayContaining([
            expect.objectContaining({
              actor_agent_id_snapshot: orchestratorId,
            }),
          ]),
          status: 'active',
        }),
      ],
    })

    const cjkSearchResponse = await postMemory('search', {
      project_id: workspaceId,
      from_agent_id: workerId,
      token: workerToken,
      query: '访问链',
    })
    expect(cjkSearchResponse.status).toBe(200)
    await expect(cjkSearchResponse.json()).resolves.toEqual({
      ok: true,
      results: [
        expect.objectContaining({
          id: cjkPayload.memory.id,
          index_name: 'trigram',
          status: 'active',
        }),
      ],
    })

    const workerForgetResponse = await postMemory('forget', {
      project_id: workspaceId,
      from_agent_id: workerId,
      token: workerToken,
      memory_id: addPayload.memory.id,
    })
    expect(workerForgetResponse.status).toBe(403)

    const forgetResponse = await postMemory('forget', {
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchestratorToken,
      memory_id: addPayload.memory.id,
    })
    expect(forgetResponse.status).toBe(200)
    await expect(forgetResponse.json()).resolves.toEqual({
      memory: expect.objectContaining({
        archived_at: expect.any(Number),
        id: addPayload.memory.id,
        status: 'archived',
      }),
      ok: true,
    })

    const archivedSearchResponse = await postMemory('search', {
      project_id: workspaceId,
      from_agent_id: workerId,
      token: workerToken,
      query: 'remote relay',
    })
    expect(archivedSearchResponse.status).toBe(200)
    await expect(archivedSearchResponse.json()).resolves.toEqual({
      ok: true,
      results: [],
    })

    const showArchivedResponse = await postMemory('show', {
      project_id: workspaceId,
      from_agent_id: workerId,
      token: workerToken,
      memory_id: addPayload.memory.id,
    })
    expect(showArchivedResponse.status).toBe(200)
    await expect(showArchivedResponse.json()).resolves.toEqual({
      memory: expect.objectContaining({
        id: addPayload.memory.id,
        sources: expect.arrayContaining([expect.objectContaining({ source_type: 'manual' })]),
        status: 'archived',
      }),
      ok: true,
    })
  })

  test('search and forget validate payloads and preserve status boundaries', async () => {
    await expect(
      postMemory('search', {
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchestratorToken,
        query: '',
      }).then((response) => response.json().then((body) => [response.status, body]))
    ).resolves.toEqual([400, { error: expect.any(String) }])

    await expect(
      postMemory('search', {
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchestratorToken,
        query: 'remote',
        limit: -1,
      }).then((response) => response.json().then((body) => [response.status, body]))
    ).resolves.toEqual([400, { error: expect.any(String) }])

    await expect(
      postMemory('forget', {
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchestratorToken,
      }).then((response) => response.json().then((body) => [response.status, body]))
    ).resolves.toEqual([400, { error: expect.any(String) }])

    await expect(
      postMemory('forget', {
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchestratorToken,
        memory_id: 'missing-memory',
      }).then((response) => response.json().then((body) => [response.status, body]))
    ).resolves.toEqual([404, { error: expect.any(String) }])
  })

  test('rejects missing auth and invalid add payloads', async () => {
    await expect(
      postMemory('add', {
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        body: 'No token should fail',
      }).then((response) => response.json().then((body) => [response.status, body]))
    ).resolves.toEqual([401, { error: expect.any(String) }])

    await expect(
      postMemory('add', {
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchestratorToken,
        body: '',
      }).then((response) => response.json().then((body) => [response.status, body]))
    ).resolves.toEqual([400, { error: expect.any(String) }])

    await expect(
      postMemory('add', {
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchestratorToken,
        body: 'bad kind',
        kind: 'todo',
      }).then((response) => response.json().then((body) => [response.status, body]))
    ).resolves.toEqual([400, { error: expect.any(String) }])
  })
})
