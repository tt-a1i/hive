import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let server: Awaited<ReturnType<typeof startTestServer>> | undefined
let workspaceId = ''
let orchestratorId = ''
let token = ''
const tempDirs: string[] = []

beforeEach(async () => {
  server = await startTestServer()
  const cookie = await getUiCookie(server.baseUrl)
  const workspacePath = mkdtempSync(join(tmpdir(), 'hive-team-recall-api-'))
  tempDirs.push(workspacePath)
  const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  workspaceId = workspace.id
  orchestratorId = `${workspaceId}:orchestrator`
  await fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/agents/${orchestratorId}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    }),
  })
  const startResponse = await fetch(
    `${server.baseUrl}/api/workspaces/${workspaceId}/agents/${orchestratorId}/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ hive_port: server.baseUrl.split(':').at(-1) ?? '' }),
    }
  )
  expect(startResponse.status).toBe(201)
  token = server.store.peekAgentToken(orchestratorId) ?? ''
  if (!token) throw new Error('Expected orchestrator token')
})

afterEach(async () => {
  await server?.close()
  server = undefined
  workspaceId = ''
  orchestratorId = ''
  token = ''
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const postRecall = (body: unknown) => {
  if (!server) throw new Error('Expected test server')
  return fetch(`${server.baseUrl}/api/team/recall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const readStatusAndError = async (response: Response) => {
  const body = (await response.json()) as { error?: unknown }
  return [response.status, body] as const
}

describe('/api/team/recall', () => {
  test('returns message and dispatch evidence through the real HTTP route', async () => {
    if (!server) throw new Error('Expected test server')
    const runtime = server
    const worker = server.store.addWorker(workspaceId, { name: 'Alice', role: 'coder' })
    runtime.store.configureAgentLaunch(workspaceId, worker.id, {
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.setRawMode(true); process.stdin.on('data', data => process.stdout.write(data)); process.stdout.write('RECALL_READY'); process.stdin.resume()",
      ],
    })
    await runtime.store.startAgent(workspaceId, worker.id, {
      hivePort: new URL(runtime.baseUrl).port,
    })
    await expect
      .poll(() => runtime.store.getActiveRunByAgentId(workspaceId, worker.id)?.output)
      .toContain('RECALL_READY')
    server.store.recordUserInput(
      workspaceId,
      orchestratorId,
      'User asked for a relay recall smoke marker.'
    )
    const dispatch = await server.store.dispatchTask(
      workspaceId,
      worker.id,
      'Investigate relay recall smoke.',
      {
        autoStartWorker: false,
        fromAgentId: orchestratorId,
      }
    )
    await expect
      .poll(() => runtime.store.getActiveRunByAgentId(workspaceId, worker.id)?.output)
      .toContain('Investigate relay recall smoke.')
    await expect
      .poll(() => runtime.store.listDispatches(workspaceId).find((item) => item.id === dispatch.id))
      .toMatchObject({ status: 'submitted', deliveredAt: expect.any(Number) })
    server.store.reportTask(workspaceId, worker.id, {
      dispatchId: dispatch.id,
      status: 'success',
      text: 'Relay recall smoke finished successfully.',
    })

    const response = await postRecall({
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token,
      query: 'relay recall smoke',
      limit: 10,
      window: 1,
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      results: Array<{
        dispatch_id: string | null
        message_type: string | null
        report_text: string | null
        source_type: string
        text: string
      }>
    }
    expect(body.ok).toBe(true)
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message_type: 'user_input',
          source_type: 'message',
          text: 'User asked for a relay recall smoke marker.',
        }),
        expect.objectContaining({
          dispatch_id: dispatch.id,
          report_text: 'Relay recall smoke finished successfully.',
          source_type: 'dispatch',
        }),
      ])
    )
  })

  test('returns low-confidence active memory through recall without requiring dispatch injection', async () => {
    if (!server) throw new Error('Expected test server')
    const memory = server.store.addMemoryEntry({
      actor: { id: orchestratorId, name: 'Queen', role: 'orchestrator' },
      body: 'Low confidence pull-only marker: zeta retry policy is still unverified.',
      confidence: 0.2,
      kind: 'pitfall',
      source: 'dream',
      tags: ['zeta'],
      workspaceId,
    })

    const response = await postRecall({
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token,
      query: 'zeta retry policy',
      limit: 10,
      window: 1,
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      results: Array<{
        memory_confidence: number | null
        memory_id: string | null
        memory_kind: string | null
        memory_status: string | null
        memory_tags: string[]
        source_type: string
        text: string
      }>
    }
    expect(body.ok).toBe(true)
    expect(body.results).toEqual([
      expect.objectContaining({
        memory_confidence: 0.2,
        memory_id: memory.id,
        memory_kind: 'pitfall',
        memory_status: 'active',
        memory_tags: ['zeta'],
        source_type: 'memory',
        text: 'Low confidence pull-only marker: zeta retry policy is still unverified.',
      }),
    ])
  })

  test('rejects missing token before reading recall data', async () => {
    const response = await postRecall({
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      query: 'anything',
    })

    await expect(readStatusAndError(response)).resolves.toEqual([
      401,
      { error: expect.any(String) },
    ])
  })

  test('rejects empty query and invalid limit/window', async () => {
    await expect(
      postRecall({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token,
        query: '',
      }).then(readStatusAndError)
    ).resolves.toEqual([400, { error: expect.any(String) }])

    await expect(
      postRecall({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token,
        query: 'anything',
        limit: -1,
      }).then(readStatusAndError)
    ).resolves.toEqual([400, { error: expect.any(String) }])

    await expect(
      postRecall({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token,
        query: 'anything',
        window: 1.5,
      }).then(readStatusAndError)
    ).resolves.toEqual([400, { error: expect.any(String) }])
  })

  test('rejects oversized remote-amplifying queries', async () => {
    const response = await postRecall({
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token,
      query: 'x'.repeat(241),
    })

    await expect(readStatusAndError(response)).resolves.toEqual([
      400,
      { error: expect.any(String) },
    ])
  })
})
