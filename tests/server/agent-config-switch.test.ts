import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { expandInboxReferences } from '../helpers/inbox.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

test('switching an orchestrator preset clears the old session and delivers ledger handover', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-switch-config-'))
  const workspacePath = join(root, 'project')
  mkdirSync(workspacePath)
  const oldScript = join(root, 'old.cjs')
  const newScript = join(root, 'new.cjs')
  writeFileSync(
    oldScript,
    "process.stdout.write('SESSION_ID:old-session\\n'); process.stdin.resume()"
  )
  writeFileSync(
    newScript,
    "process.stdout.write('ARGS:' + JSON.stringify(process.argv.slice(2)) + '\\n'); process.stdin.on('data', x => process.stdout.write('INPUT:' + x)); process.stdin.resume()"
  )
  const server = await startTestServer({ dataDir: join(root, 'data') })
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    const cookie = await getUiCookie(server.baseUrl)
    const headers = { cookie, 'content-type': 'application/json' }
    const preset = (name: string, script: string, capture: boolean) =>
      server.store.settings.createCommandPreset({
        displayName: name,
        command: process.execPath,
        args: [script],
        env: {},
        resumeArgsTemplate: '--resume {session_id}',
        sessionIdCapture: capture
          ? { source: 'stdout_regex', pattern: 'SESSION_ID:([a-z-]+)' }
          : null,
        yoloArgsTemplate: null,
      })
    const a = preset('Engine A', oldScript, true)
    const b = preset('Engine B', newScript, false)
    const create = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Switch', path: workspacePath, autostart_orchestrator: false }),
    })
    expect(create.status).toBe(201)
    const workspace = (await create.json()) as { id: string }
    const orch = `${workspace.id}:orchestrator`
    const agentUrl = `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${orch}`
    const configure = async (id: string, args: string[]) =>
      fetch(`${agentUrl}/config`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: process.execPath, command_preset_id: id, args }),
      })
    expect((await configure(a.id, [oldScript])).status).toBe(204)
    const start = async () => fetch(`${agentUrl}/start`, { method: 'POST', headers, body: '{}' })
    expect((await start()).status).toBe(201)
    const session = () =>
      db
        .prepare(
          'SELECT last_session_id FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
        )
        .get(workspace.id, orch)
    await vi.waitFor(() => expect(session()).toEqual({ last_session_id: 'old-session' }))
    // Same-engine argument changes preserve the captured session.
    expect((await configure(a.id, [oldScript, '--same-engine'])).status).toBe(204)
    expect(session()).toEqual({ last_session_id: 'old-session' })
    db.exec(
      `CREATE TRIGGER fail_switch BEFORE UPDATE OF last_session_id ON workers BEGIN SELECT RAISE(ABORT, 'blocked switch'); END`
    )
    expect((await configure(b.id, [newScript])).status).toBe(500)
    expect(session()).toEqual({ last_session_id: 'old-session' })
    expect(server.store.peekAgentLaunchConfig(workspace.id, orch)?.commandPresetId).toBe(a.id)
    expect(
      db
        .prepare(
          'SELECT command_preset_id FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?'
        )
        .get(workspace.id, orch)
    ).toEqual({ command_preset_id: a.id })
    db.exec('DROP TRIGGER fail_switch')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = await server.store.dispatchTask(
      workspace.id,
      worker.id,
      'deliver ledger marker',
      {
        fromAgentId: orch,
        autoStartWorker: false,
      }
    )
    await server.store.cancelTask(workspace.id, dispatch.id, {
      fromAgentId: orch,
      reason: 'completed test',
    })
    expect(server.store.listOpenDispatches(workspace.id)).toEqual([])
    const run = server.store.getActiveRunByAgentId(workspace.id, orch)
    if (!run) throw new Error('missing orchestrator run')
    expect(
      (
        await fetch(`${server.baseUrl}/api/runtime/runs/${run.runId}/stop`, {
          method: 'POST',
          headers,
        })
      ).status
    ).toBe(202)
    await vi.waitFor(() =>
      expect(server.store.getActiveRunByAgentId(workspace.id, orch)).toBeUndefined()
    )
    expect((await configure(b.id, [newScript])).status).toBe(204)
    expect(session()).toBeUndefined()
    expect(db.prepare('SELECT last_session_id FROM workers WHERE id = ?').get(orch)).toEqual({
      last_session_id: null,
    })
    expect((await start()).status).toBe(201)
    await vi.waitFor(
      () => {
        const output = server.store.getActiveRunByAgentId(workspace.id, orch)?.output ?? ''
        const expanded = expandInboxReferences(output)
        expect(expanded).toContain('deliver ledger marker')
        expect(expanded).toContain('cancelled')
        expect(output).toContain('ARGS:[]')
        expect(output).not.toContain('old-session')
      },
      { timeout: 5000 }
    )
  } finally {
    db.close()
    await server.close()
    removeTestPath(root)
  }
}, 15000)

test('saving a different engine prevents a still-running old PTY from recording a late session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-switch-late-capture-'))
  const server = await startTestServer({ dataDir: join(root, 'data') })
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    const workspace = server.store.createWorkspace(root, 'late session')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [
        '-e',
        "setTimeout(() => process.stdout.write('SESSION_ID:stale-session\\nLATE_BANNER\\n'), 500); process.stdin.resume()",
      ],
      sessionIdCapture: { source: 'stdout_regex', pattern: 'SESSION_ID:([a-z-]+)' },
    })
    const run = await server.store.startAgent(workspace.id, worker.id, { hivePort: '0' })
    expect(run.captureController?.signal.aborted).toBe(false)
    const cookie = await getUiCookie(server.baseUrl)
    const configured = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ command: '/bin/sh', args: [] }),
      }
    )
    expect(configured.status).toBe(204)
    expect(run.captureController?.signal.aborted).toBe(true)
    await vi.waitFor(() =>
      expect(server.store.getActiveRunByAgentId(workspace.id, worker.id)?.output).toContain(
        'LATE_BANNER'
      )
    )
    expect(
      db
        .prepare(
          'SELECT last_session_id FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
        )
        .get(workspace.id, worker.id)
    ).toBeUndefined()
    expect(db.prepare('SELECT last_session_id FROM workers WHERE id = ?').get(worker.id)).toEqual({
      last_session_id: null,
    })
  } finally {
    db.close()
    await server.close()
    removeTestPath(root)
  }
}, 10000)
