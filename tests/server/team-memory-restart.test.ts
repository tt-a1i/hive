import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'

test('approved member memory survives restart and reaches another member without inactive or foreign entries', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-memory-restart-'))
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined
  try {
    server = await startTestServer({ dataDir })
    const workspacePath = join(dataDir, 'workspace')
    const foreignPath = join(dataDir, 'foreign')
    mkdirSync(workspacePath)
    mkdirSync(foreignPath)
    const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
    const foreign = server.store.createWorkspace(foreignPath, 'Beta')
    const author = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const reader = server.store.addWorker(workspace.id, { name: 'Bob', role: 'coder' })
    const originalStore = server.store
    const actor = { id: author.id, name: author.name, role: author.role }
    const add = (body: string, workspaceId = workspace.id) =>
      originalStore.addMemoryEntry({
        actor,
        body,
        kind: 'pitfall',
        tags: ['relay_restart_contract'],
        workspaceId,
      })
    const memory = add('relay_restart_contract requires the E2E relay rather than a gateway proxy.')
    expect(memory.status).toBe('candidate')
    server.store.approveMemoryCandidate(workspace.id, memory.id)
    const disabled = add('relay_restart_contract disabled guidance')
    server.store.approveMemoryCandidate(workspace.id, disabled.id)
    server.store.setMemoryDisabled(workspace.id, disabled.id, true)
    const archived = add('relay_restart_contract archived guidance')
    server.store.approveMemoryCandidate(workspace.id, archived.id)
    server.store.archiveMemoryEntry(workspace.id, archived.id)
    add('relay_restart_contract unapproved guidance')
    const foreignMemory = add('relay_restart_contract foreign workspace guidance', foreign.id)
    server.store.approveMemoryCandidate(foreign.id, foreignMemory.id)

    await server.close()
    server = undefined
    server = await startTestServer({ dataDir })
    const restarted = server
    expect(server.store.getMemoryEntry(workspace.id, memory.id)?.sources).toEqual(memory.sources)
    const orchestrator = server.store
      .getWorkspaceSnapshot(workspace.id)
      .agents.find((agent) => agent.role === 'orchestrator')
    if (!orchestrator) throw new Error('Expected persisted orchestrator')
    for (const agent of [orchestrator, reader]) {
      server.store.configureAgentLaunch(workspace.id, agent.id, {
        command: process.execPath,
        args: [
          '-e',
          "process.stdin.setEncoding('utf8');process.stdin.on('data',c=>process.stdout.write(c))",
        ],
      })
      await server.store.startAgent(workspace.id, agent.id, {
        hivePort: server.baseUrl.split(':').at(-1) ?? '',
      })
      await server.store.getActiveRunByAgentId(workspace.id, agent.id)?.postStartInputReady
    }
    const post = (path: string, agentId: string, payload: Record<string, unknown>) =>
      fetch(`${restarted.baseUrl}/api/team/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: agentId,
          token: restarted.store.peekAgentToken(agentId),
          ...payload,
        }),
      })
    const search = await post('memory/search', reader.id, { query: 'relay_restart_contract' })
    expect(search.status).toBe(200)
    await expect(search.json()).resolves.toMatchObject({
      ok: true,
      results: [expect.objectContaining({ id: memory.id })],
    })
    const text = 'Implement relay_restart_contract mobile login'
    const send = await post('send', orchestrator.id, { to: reader.name, text })
    expect(send.status).toBe(202)
    await expect
      .poll(() => restarted.store.getActiveRunByAgentId(workspace.id, reader.id)?.output, {
        timeout: 8000,
      })
      .toContain(text)
    const dispatchMemory = () =>
      restarted.store
        .getActiveRunByAgentId(workspace.id, reader.id)
        ?.output.match(/<hive-memory context="dispatch">([\s\S]*?)<\/hive-memory>/)?.[1]
    await expect.poll(dispatchMemory, { timeout: 8000 }).toContain(memory.body)
    expect(dispatchMemory()).not.toContain(disabled.body)
    expect(dispatchMemory()).not.toContain(archived.body)
    expect(dispatchMemory()).not.toContain(foreignMemory.body)
    expect(dispatchMemory()).not.toContain('unapproved guidance')
  } finally {
    await server?.close()
    removeTestPath(dataDir)
  }
}, 30000)
