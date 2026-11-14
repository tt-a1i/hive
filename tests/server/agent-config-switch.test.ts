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
    expect(
      db
        .prepare('SELECT value FROM app_state WHERE key = ?')
        .get(`agent_handover:${workspace.id}:${orch}`)
    ).toBeUndefined()
    const configResponse = await fetch(`${agentUrl}/config`, { headers })
    expect(configResponse.status).toBe(200)
    expect(await configResponse.json()).toEqual(
      expect.objectContaining({
        command: process.execPath,
        args: [oldScript],
        command_preset_id: a.id,
      })
    )
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
      `CREATE TABLE switch_parent (id INTEGER PRIMARY KEY);
       CREATE TABLE switch_child (id INTEGER REFERENCES switch_parent(id) DEFERRABLE INITIALLY DEFERRED);
       CREATE TRIGGER fail_switch AFTER UPDATE OF last_session_id ON workers BEGIN INSERT INTO switch_child VALUES (1); END;`
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
    const switched = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/agents/${orch}/switch`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ command_preset_id: b.id, restart: true }),
      }
    )
    expect(switched.status).toBe(200)
    expect(await switched.json()).toEqual({ run_id: expect.any(String) })
    expect(session()).toBeUndefined()
    const handoverKey = encodeURIComponent(`agent_handover:${workspace.id}:${orch}`)
    expect(
      (await fetch(`${server.baseUrl}/api/settings/app-state/${handoverKey}`, { headers })).status
    ).toBe(403)
    expect(
      (
        await fetch(`${server.baseUrl}/api/settings/app-state/${handoverKey}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ value: null }),
        })
      ).status
    ).toBe(403)
    expect(db.prepare('SELECT last_session_id FROM workers WHERE id = ?').get(orch)).toEqual({
      last_session_id: null,
    })
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

test('shell-wrapped package runners distinguish engines while preserving same-engine arguments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-switch-shell-'))
  const dataDir = join(root, 'data')
  const first = await startTestServer({ dataDir })
  let second: Awaited<ReturnType<typeof startTestServer>> | undefined
  try {
    const workspace = first.store.createWorkspace(root, 'shell engine')
    const worker = first.store.addWorker(workspace.id, { name: 'Worker', role: 'coder' })
    const path = `/api/workspaces/${workspace.id}/agents/${worker.id}/config`
    const cookie = await getUiCookie(first.baseUrl)
    const post = (baseUrl: string, cookieValue: string, startup: string) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { cookie: cookieValue, 'content-type': 'application/json' },
        body: JSON.stringify({ startup_command: startup }),
      })
    expect((await post(first.baseUrl, cookie, 'npx -y @anthropic-ai/claude-code')).status).toBe(204)
    const previous = first.store.peekAgentLaunchConfig(workspace.id, worker.id)
    await first.close()
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    try {
      db.prepare(
        'INSERT INTO agent_sessions (workspace_id, agent_id, last_session_id, updated_at) VALUES (?, ?, ?, ?)'
      ).run(workspace.id, worker.id, 'old-session', 1)
      db.prepare('UPDATE workers SET last_session_id = ? WHERE id = ?').run(
        'old-session',
        worker.id
      )
    } finally {
      db.close()
    }
    second = await startTestServer({ dataDir })
    const secondCookie = await getUiCookie(second.baseUrl)
    expect(
      (await post(second.baseUrl, secondCookie, 'npx -y @anthropic-ai/claude-code --verbose'))
        .status
    ).toBe(204)
    const check = new Database(join(dataDir, 'runtime.sqlite'))
    try {
      expect(
        check
          .prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id = ?')
          .get(worker.id)
      ).toEqual({ last_session_id: 'old-session' })
      expect((await post(second.baseUrl, secondCookie, 'npx -y @openai/codex')).status).toBe(204)
      const current = second.store.peekAgentLaunchConfig(workspace.id, worker.id)
      expect(current?.command).toBe(previous?.command)
      expect(current?.interactiveCommand).toBe(previous?.interactiveCommand)
      expect(
        check
          .prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id = ?')
          .get(worker.id)
      ).toBeUndefined()
      expect(
        check.prepare('SELECT last_session_id FROM workers WHERE id = ?').get(worker.id)
      ).toEqual({ last_session_id: null })
    } finally {
      check.close()
    }
  } finally {
    await second?.close()
    removeTestPath(root)
  }
}, 10000)
