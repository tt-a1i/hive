import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'

test('a user input is removed if the real PTY exits before asynchronous delivery', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-input-rollback-'))
  const executable = join(dataDir, 'hermes')
  writeFileSync(executable, `#!/bin/sh\nsleep 0.5\nexit 1\n`)
  chmodSync(executable, 0o755)
  const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
  const workspace = store.createWorkspace(dataDir, 'input rollback')
  const orchestratorId = `${workspace.id}:orchestrator`
  store.configureAgentLaunch(workspace.id, orchestratorId, { command: executable })
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  try {
    await store.startAgent(workspace.id, orchestratorId, { hivePort: '0' })
    const write = store.recordUserInput(workspace.id, orchestratorId, 'delivery must roll back')
    expect(db.prepare("SELECT text FROM messages WHERE type = 'user_input'").all()).toEqual([
      { text: 'delivery must roll back' },
    ])
    await expect(write).rejects.toThrow()
    expect(db.prepare("SELECT text FROM messages WHERE type = 'user_input'").all()).toEqual([])
  } finally {
    db.close()
    await store.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}, 10_000)

test('a failed SQLite insert never writes user input to the PTY', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-input-insert-'))
  const script = join(dataDir, 'echo.js')
  writeFileSync(
    script,
    "process.stdin.on('data', (chunk) => process.stdout.write('INPUT:' + chunk)); process.stdin.resume()"
  )
  const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
  const workspace = store.createWorkspace(dataDir, 'input insert failure')
  const orchestratorId = `${workspace.id}:orchestrator`
  store.configureAgentLaunch(workspace.id, orchestratorId, {
    command: process.execPath,
    args: [script],
  })
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  try {
    const run = await store.startAgent(workspace.id, orchestratorId, { hivePort: '0' })
    await run.postStartInputReady
    db.exec(
      `CREATE TRIGGER fail_user_input BEFORE INSERT ON messages WHEN NEW.type = 'user_input' BEGIN SELECT RAISE(ABORT, 'blocked'); END`
    )
    await expect(
      store.recordUserInput(workspace.id, orchestratorId, 'never deliver marker')
    ).rejects.toThrow()
    expect(db.prepare("SELECT text FROM messages WHERE type = 'user_input'").all()).toEqual([])
    store.writeRunInput(run.runId, 'probe marker\n')
    await vi.waitFor(() => {
      const output = store.getActiveRunByAgentId(workspace.id, orchestratorId)?.output
      expect(output).toContain('INPUT:probe marker')
      expect(output).not.toContain('never deliver marker')
    })
  } finally {
    db.close()
    await store.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}, 10_000)
