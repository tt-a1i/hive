import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'
import { startReportWorker } from '../helpers/report-worker.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH
const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const FAKE_CLAUDE_EXIT_MS = 250

const writeFakeClaudeCli = (binDir: string) => {
  const scriptPath = join(binDir, 'fake-claude.js')
  writeFileSync(
    scriptPath,
    `process.stdin.resume(); setTimeout(() => process.exit(0), ${FAKE_CLAUDE_EXIT_MS})\n`
  )

  const unixCli = join(binDir, 'claude')
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)

  const winCli = join(binDir, 'claude.cmd')
  writeFileSync(winCli, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`)
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close()
  }
  process.env.PATH = originalPath
  delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('runtime rehydration', () => {
  test('restores workers and pending task counts from sqlite state', async () => {
    const {
      store: firstStore,
      workspace,
      worker: bob,
      send,
      report,
      dataDir,
      close,
    } = await startReportWorker({
      name: 'Bob',
      role: 'tester',
      description: 'User chosen validation scope',
    })
    const alice = firstStore.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
      description: 'User chosen implementation scope',
    })
    await firstStore.dispatchTask(workspace.id, alice.id, 'Implement login')
    const dispatch = await send('Write tests')
    expect((await report(dispatch.id, 'Tests written')).status).toBe(202)
    await close()

    const secondStore = createRuntimeStore({ dataDir })
    stores.push(secondStore)

    expect(
      secondStore.listWorkers(workspace.id).sort((a, b) => a.name.localeCompare(b.name))
    ).toEqual([
      {
        id: alice.id,
        name: 'Alice',
        role: 'coder',
        description: 'User chosen implementation scope',
        status: 'stopped',
        pendingTaskCount: 1,
      },
      {
        id: bob.id,
        name: 'Bob',
        role: 'tester',
        description: 'User chosen validation scope',
        status: 'stopped',
        pendingTaskCount: 0,
      },
    ])
  })

  test('restores pending task counts from dispatches instead of legacy message replay', async () => {
    const { workspace, worker: alice, send, report, dataDir, close } = await startReportWorker()
    const first = await send('First')
    await send('Second')
    expect((await report(first.id, 'First completed')).status).toBe(202)
    await close()

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.prepare(
      `INSERT INTO messages (
         workspace_id,
         worker_id,
         type,
         from_agent_id,
         to_agent_id,
         text,
         status,
         artifacts,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      workspace.id,
      alice.id,
      'report',
      alice.id,
      null,
      'legacy orphan report',
      null,
      '[]',
      Date.now()
    )
    db.close()

    const secondStore = createRuntimeStore({ dataDir })
    stores.push(secondStore)

    expect(secondStore.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ id: alice.id, pendingTaskCount: 1, status: 'stopped' })
    )
  })

  test('captures Claude session id into sqlite and reuses it on next start', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-runtime-session-'))
    const workspacePath = join(dataDir, 'workspace')
    const claudeProjectsDir = join(dataDir, 'claude-projects')
    const binDir = join(dataDir, 'bin')
    tempDirs.push(dataDir)
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(join(claudeProjectsDir, '-tmp-hive-alpha'), { recursive: true })
    writeFakeClaudeCli(binDir)
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`

    const firstStore = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(firstStore)
    const workspace = firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = firstStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    firstStore.configureAgentLaunch(workspace.id, worker.id, {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: {
        pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
        source: 'claude_project_jsonl_dir',
      },
    })

    process.env.HIVE_CLAUDE_PROJECTS_DIR = claudeProjectsDir
    const sessionFile = join(
      claudeProjectsDir,
      '-tmp-hive-alpha',
      '11111111-1111-4111-8111-111111111111.jsonl'
    )
    const workerPromptMarker = `Hive session binding: workspace_id=${workspace.id}; agent_id=${worker.id}`
    const manager = createAgentManager()
    const startSpy = vi.spyOn(manager, 'startAgent')

    const secondStore = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(secondStore)
    secondStore.configureAgentLaunch(workspace.id, worker.id, {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: {
        pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
        source: 'claude_project_jsonl_dir',
      },
    })

    const startPromise = secondStore.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ message: { content: workerPromptMarker, role: 'user' } })}\n`
    )
    await startPromise

    await new Promise((resolve) => setTimeout(resolve, 150))

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    const persistedSession = db
      .prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id = ?')
      .get(worker.id) as { last_session_id: string } | undefined
    const mirroredWorkerSession = db
      .prepare('SELECT last_session_id FROM workers WHERE id = ?')
      .get(worker.id) as { last_session_id: string | null } | undefined
    db.close()

    const thirdStore = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(thirdStore)
    thirdStore.configureAgentLaunch(workspace.id, worker.id, {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: {
        pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
        source: 'claude_project_jsonl_dir',
      },
    })
    await thirdStore.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    const firstCallArgs = startSpy.mock.calls[0]?.[0]?.args ?? []
    const secondCallArgs = startSpy.mock.calls[1]?.[0]?.args ?? []

    expect(firstCallArgs).toEqual([
      '--dangerously-skip-permissions',
      '--permission-mode=bypassPermissions',
      '--disallowedTools=Task',
    ])
    expect(secondCallArgs).toEqual([
      '--dangerously-skip-permissions',
      '--permission-mode=bypassPermissions',
      '--disallowedTools=Task',
      '--resume',
      '11111111-1111-4111-8111-111111111111',
    ])
    expect(persistedSession).toEqual({ last_session_id: '11111111-1111-4111-8111-111111111111' })
    expect(mirroredWorkerSession).toEqual({
      last_session_id: '11111111-1111-4111-8111-111111111111',
    })

    // The fake CLI only needs to stay up long enough for spawn + session capture.
    // Let it exit naturally so Windows ConPTY cleanup does not need a forced kill.
    await new Promise((resolve) => setTimeout(resolve, FAKE_CLAUDE_EXIT_MS + 250))

    delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  })
})
