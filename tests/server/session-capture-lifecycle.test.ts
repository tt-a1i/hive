import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

afterEach(() => vi.unstubAllEnvs())

// Two real runtimes share a native session directory, as concurrent agents do.
// Inspect their live AbortSignals only to distinguish cancellation from capture timeout.
test.each([
  'stop',
  'close',
] as const)('%s cancels its active native capture without cancelling a sibling runtime waiter', async (action) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-capture-lifecycle-'))
  const workspacePath = join(root, 'workspace')
  const geminiHome = join(root, 'gemini')
  vi.stubEnv('HIVE_GEMINI_HOME', join(root, 'unused-default-home'))
  const chats = join(geminiHome, 'tmp', 'shared-project', 'chats')
  mkdirSync(workspacePath)
  mkdirSync(chats, { recursive: true })
  writeFileSync(join(geminiHome, 'tmp', 'shared-project', '.project_root'), workspacePath)
  const first = await startTestServer({ dataDir: join(root, 'first') })
  const sibling = await startTestServer({ dataDir: join(root, 'sibling') })
  const readSession = (dataDir: string, agentId: string) => {
    const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
    try {
      return (
        (
          db
            .prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id = ?')
            .get(agentId) as { last_session_id: string | null } | undefined
        )?.last_session_id ?? null
      )
    } finally {
      db.close()
    }
  }
  try {
    const start = async (server: typeof first, name: string) => {
      const workspace = server.store.createWorkspace(workspacePath, name)
      const worker = server.store.addWorker(workspace.id, { name, role: 'coder' })
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: process.execPath,
        args: ['-e', "process.stdin.resume(); process.stdout.write('CAPTURE_WAITING')"],
        sessionIdCapture: {
          source: 'gemini_session_json_dir',
          pattern: join(geminiHome, 'tmp', '*', 'chats', 'session-*.json'),
        },
      })
      const cookie = await getUiCookie(server.baseUrl)
      const response = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
        { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }
      )
      expect(response.status).toBe(201)
      const run = server.store.getActiveRunByAgentId(workspace.id, worker.id)
      if (!run?.captureController) throw new Error('Expected an active capture controller')
      await expect
        .poll(() => server.store.getActiveRunByAgentId(workspace.id, worker.id)?.output, {
          timeout: 5000,
        })
        .toContain('CAPTURE_WAITING')
      expect(run.captureController.signal.aborted).toBe(false)
      expect(readSession(server.dataDir, worker.id)).toBeNull()
      return { worker, run, cookie, workspaceId: workspace.id }
    }
    const stopped = await start(first, 'Stopped')
    const waiting = await start(sibling, 'Survivor')
    if (action === 'stop') {
      const response = await fetch(`${first.baseUrl}/api/runtime/runs/${stopped.run.runId}/stop`, {
        method: 'POST',
        headers: { cookie: stopped.cookie },
      })
      expect(response.status).toBe(202)
    } else await first.store.close()
    expect(stopped.run.captureController?.signal.aborted).toBe(true)
    expect(waiting.run.captureController?.signal.aborted).toBe(false)

    const sessionId = '5ea385a5-9ac2-4bc8-a94a-f3cc3b1c77ea'
    writeFileSync(join(chats, 'session-survivor.json'), JSON.stringify({ sessionId }))
    await expect
      .poll(() => readSession(sibling.dataDir, waiting.worker.id), { timeout: 3000 })
      .toBe(sessionId)
    expect(readSession(first.dataDir, stopped.worker.id)).toBeNull()
    expect(
      sibling.store.getActiveRunByAgentId(waiting.workspaceId, waiting.worker.id)?.status
    ).toBe('running')
  } finally {
    await Promise.all([first.close(), sibling.close()])
    removeTestPath(root)
  }
}, 15000)
