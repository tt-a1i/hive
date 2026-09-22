import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import {
  serializeWorkspaceMemoryEnabled,
  workspaceMemoryEnabledKey,
} from '../../src/server/team-memory-feature.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalClaudeProjectsDir = process.env.HIVE_CLAUDE_PROJECTS_DIR

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 4000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

const waitForPtyOutputFlush = () => new Promise((resolve) => setTimeout(resolve, 50))

const ESCAPE = String.fromCharCode(27)
const BELL = String.fromCharCode(7)
const TERMINAL_CONTROL_PATTERN = new RegExp(
  `${ESCAPE}\\[[0-?]*[ -/]*[@-~]|${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`,
  'gu'
)

const compactTerminalText = (text: string) =>
  text.replace(TERMINAL_CONTROL_PATTERN, '').replace(/\s+/gu, '')

const expectOutputToContainTerminalText = (output: string, text: string) => {
  expect(compactTerminalText(output)).toContain(compactTerminalText(text))
}

const listSystemMessages = (
  dataDir: string,
  type: 'system_env_sync' | 'system_recovery_summary'
) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
  const rows = db
    .prepare('SELECT type, worker_id, text FROM messages WHERE type = ? ORDER BY sequence ASC')
    .all(type) as Array<{ text: string; type: string; worker_id: string }>
  db.close()
  return rows
}

const listMemoryInjections = (dataDir: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
  const rows = db
    .prepare(
      `SELECT context_type, memory_id, target_agent_id_snapshot, workspace_id
       FROM memory_injections
       ORDER BY injected_at ASC, id ASC`
    )
    .all() as Array<{
    context_type: string
    memory_id: string
    target_agent_id_snapshot: string
    workspace_id: string
  }>
  db.close()
  return rows
}

const listRecoverySourceMessages = (dataDir: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
  const rows = db
    .prepare(
      "SELECT type, text FROM messages WHERE type IN ('user_input', 'send', 'report') ORDER BY sequence ASC"
    )
    .all() as Array<{ text: string; type: 'report' | 'send' | 'user_input' }>
  db.close()
  return rows
}

const readLastSessionId = (dataDir: string, workspaceId: string, agentId: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
  const row = db
    .prepare('SELECT last_session_id FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?')
    .get(workspaceId, agentId) as { last_session_id: string } | undefined
  db.close()
  return row?.last_session_id
}

const orchestratorId = (workspaceId: string) => `${workspaceId}:orchestrator`

const writeEchoAgent = (workspacePath: string, filename: string) => {
  const scriptPath = join(workspacePath, filename)
  writeFileSync(
    scriptPath,
    [
      "const { appendFileSync, writeFileSync } = require('node:fs')",
      `const receivedPath = ${JSON.stringify(`${scriptPath}.stdin`)}`,
      "writeFileSync(receivedPath, '')",
      "for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))",
      'process.stdin.setRawMode?.(true)',
      "process.stdin.setEncoding('utf8')",
      "let inputBuffer = ''",
      "process.stdin.on('data', (chunk) => {",
      '  appendFileSync(receivedPath, chunk)',
      '  const lines = (inputBuffer + chunk).split(/\\r\\n|\\r|\\n/)',
      "  inputBuffer = lines.pop() ?? ''",
      "  for (const line of lines) process.stdout.write('STDIN:' + line + '\\n')",
      "  if (chunk.includes('__HIVE_TEST_EXIT__')) setTimeout(() => process.exit(0), 100)",
      '})',
      "process.stdout.write('ARGS:' + process.argv.slice(2).join(' ') + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join('\n')
  )
  return scriptPath
}

const writeResumableClaudeEcho = (workspacePath: string) => {
  const binDir = join(workspacePath, 'bin')
  mkdirSync(binDir, { recursive: true })
  const cliPath = join(binDir, 'claude')
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(0))
}

let pasteOpen = false
const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '11111111-1111-4111-8111-111111111111'
const encoded = process.cwd().replace(/[^A-Za-z0-9-]/g, '-')
const projectsRoot = process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
const projectDir = join(projectsRoot, encoded)
const failMarker = join(process.cwd(), '.fail-next-resume')
mkdirSync(projectDir, { recursive: true })
const sessionPath = join(projectDir, sessionId + '.jsonl')
writeFileSync(sessionPath, '{}\\n')
process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  process.stdout.write('STDIN:' + chunk)
  appendFileSync(sessionPath, JSON.stringify({ message: { role: 'user', content: chunk } }) + '\\n')
  if (chunk.includes('__HIVE_TEST_EXIT__')) {
    process.stdout.write('\\nEXITING\\n')
    setTimeout(() => process.exit(0), 100)
    return
  }
  if (chunk.includes('\\u001b[200~') || chunk.includes('<hive-message') || chunk.includes('<hive-system-message')) pasteOpen = true
  if (chunk.includes('\\u001b[201~') || (process.platform === 'win32' && pasteOpen && (chunk.includes('</hive-message>') || chunk.includes('</hive-system-message>')))) {
    pasteOpen = false
    process.stdout.write('\\n[Pasted text #1 +1 lines]\\n')
  }
  if (!pasteOpen && /^[\\r\\n]+$/.test(chunk)) process.stdout.write('\\nENTER_SUBMITTED\\n❯ ')
})
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
if (args.includes('--resume') && existsSync(failMarker)) {
  process.stdout.write('RESUME_FAIL\\n')
  setTimeout(() => process.exit(1), 100)
} else {
  process.stdout.write('❯ ')
  setInterval(() => {}, 1000)
}
`
  )
  chmodSync(cliPath, 0o755)
  if (process.platform === 'win32') {
    const cmdPath = `${cliPath}.cmd`
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "%~dp0${basename(cliPath)}" %*\r\n`)
    return cmdPath
  }
  return cliPath
}

const createWorkspaceViaHttp = async (baseUrl: string, cookie: string, workspacePath: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const createWorkerViaHttp = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  name: string,
  role: 'coder' | 'tester' = 'coder'
) => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name, role }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const configureWorkerViaHttp = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  agentId: string,
  body: { args?: string[]; command: string; command_preset_id?: string | null }
) => {
  const response = await fetch(
    `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/config`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }
  )
  expect(response.status).toBe(204)
}

const startWorkerViaHttp = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  agentId: string
) => {
  const port = baseUrl.split(':').at(-1)
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ hive_port: port }),
  })
  expect(response.status).toBe(201)
  const payload = (await response.json()) as { run_id: string }
  return { runId: payload.run_id }
}

const getRunViaHttp = async (baseUrl: string, cookie: string, runId: string) => {
  const response = await fetch(`${baseUrl}/api/runtime/runs/${runId}`, { headers: { cookie } })
  expect(response.status).toBe(200)
  return (await response.json()) as { output: string; status: string }
}

const waitForRunOutput = async (baseUrl: string, cookie: string, runId: string, text: string) => {
  await waitFor(async () => {
    const state = await getRunViaHttp(baseUrl, cookie, runId)
    expect(state.output).toContain(text)
  })
}

const stopRunViaHttp = async (baseUrl: string, cookie: string, runId: string) => {
  const response = await fetch(`${baseUrl}/api/runtime/runs/${runId}/stop`, {
    method: 'POST',
    headers: { cookie },
  })
  expect(response.status).toBe(202)
  await waitFor(
    async () => {
      const state = await getRunViaHttp(baseUrl, cookie, runId)
      expect(state.status).toBe('exited')
    },
    8000,
    25
  )
}

afterEach(() => {
  if (originalClaudeProjectsDir === undefined) {
    delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  } else {
    process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir
  }
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('Layer B fallback integration', () => {
  test('orchestrator recovery summary preserves Hive worker dispatch rules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-orch-layer-b-home-'))
    const workspacePathRaw = join(root, 'workspace')
    tempDirs.push(root)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    const orchestratorScript = writeEchoAgent(workspacePath, 'orch-echo.js')
    const bobScript = writeEchoAgent(workspacePath, 'bob-echo.js')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`
      const bob = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id, 'Bob', 'tester')
      server.store.recordUserInput(workspace.id, orchestratorId, '让 worker 评估一下项目目标')

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id, {
        command: process.execPath,
        args: [bobScript],
      })
      const bobRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id)
      await waitForRunOutput(server.baseUrl, cookie, bobRun.runId, 'ARGS:')

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, orchestratorId, {
        command: process.execPath,
        args: [orchestratorScript],
      })
      const firstRun = await startWorkerViaHttp(
        server.baseUrl,
        cookie,
        workspace.id,
        orchestratorId
      )
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.output).toContain('ARGS:')
      })
      await waitForPtyOutputFlush()
      server.store.writeRunInput(firstRun.runId, '__HIVE_TEST_EXIT__\r')
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('exited')
      })

      const secondRun = await startWorkerViaHttp(
        server.baseUrl,
        cookie,
        workspace.id,
        orchestratorId
      )
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('running')
        const received = readFileSync(`${orchestratorScript}.stdin`, 'utf8')
        expect(received).toContain('让 worker 评估一下项目目标')
        expect(received).toContain('Bob')
        expect(received).toContain('Use existing members from `team list` by name.')
        expect(received).toContain('Use `team send "<member-name>" "<task>"`')
        expect(received).toContain('Keep small, direct tasks local.')
        expect(received).toContain('messages neither create nor close responsibility')
        expect(received).toContain(
          'Member reports submit outcomes, not proof of user-goal acceptance'
        )
      })
      server.store.writeRunInput(secondRun.runId, '__HIVE_TEST_EXIT__\r')
      await waitFor(async () => {
        expect((await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)).status).toBe('exited')
      })
      await stopRunViaHttp(server.baseUrl, cookie, bobRun.runId)
    } finally {
      await server.close()
    }
  }, 15_000)

  test('custom command restart receives Layer B summary built from messages, .hive/tasks.md and worker list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-layer-b-home-'))
    const workspacePathRaw = join(root, 'workspace')
    tempDirs.push(root)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    const aliceScript = writeEchoAgent(workspacePath, 'alice-echo.js')
    const bobScript = writeEchoAgent(workspacePath, 'bob-echo.js')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const alice = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id, 'Alice')
      const bob = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id, 'Bob', 'tester')
      const recoveryMemory = server.store.addMemoryEntry({
        actor: { id: orchestratorId(workspace.id), name: 'Orchestrator', role: 'orchestrator' },
        body: 'Layer B recovery should remember the relay debug decision.',
        kind: 'decision',
        tags: ['recovery'],
        workspaceId: workspace.id,
      })
      const db = new Database(join(server.dataDir, 'runtime.sqlite'))
      db.prepare('UPDATE memory_entries SET pinned = 1 WHERE id = ?').run(recoveryMemory.id)
      db.close()

      await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/tasks`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ content: '# Tasks\n- [ ] layer b fallback\n' }),
      })
      server.store.recordUserInput(
        workspace.id,
        orchestratorId(workspace.id),
        '请继续修复 restart bug'
      )
      expect(listRecoverySourceMessages(server.dataDir)).toContainEqual(
        expect.objectContaining({ type: 'user_input', text: '请继续修复 restart bug' })
      )
      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id, {
        command: process.execPath,
        args: [bobScript],
      })
      const bobRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id)
      await waitForRunOutput(server.baseUrl, cookie, bobRun.runId, 'ARGS:')

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id, {
        command: process.execPath,
        args: [aliceScript],
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.output).toContain('ARGS:')
      })
      await waitForPtyOutputFlush()
      server.store.writeRunInput(firstRun.runId, '__HIVE_TEST_EXIT__\r')
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('exited')
      })
      expect(listSystemMessages(server.dataDir, 'system_recovery_summary')).toHaveLength(0)

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain('STDIN:<hive-system-message>')
        expect(state.output).toContain('These are current responsibility facts')
        // §3.5.1 scenario C (clean exit) also uses Layer B; copy must not claim a crash
        expect(state.output).not.toContain('crash')
        expect(state.output).toContain('请继续修复 restart bug')
        expect(state.output).toContain('layer b fallback')
        expect(state.output).toContain('Bob')
        expect(state.output).toContain('<hive-memory context="recovery">')
        // Raw ConPTY output can split a sentence with wrapping/cursor sequences.
        // Verify the actual receiver input, without stripping or guessing text.
        const received = readFileSync(`${aliceScript}.stdin`, 'utf8')
        expect(received).toContain('请继续修复 restart bug')
        expect(received).toContain('layer b fallback')
        expect(received).toContain('Layer B recovery should remember the relay debug decision.')
        expect(received.indexOf('请继续修复 restart bug')).toBeLessThan(
          received.indexOf('Layer B recovery should remember')
        )
        expect(received.indexOf('layer b fallback')).toBeLessThan(
          received.indexOf('Layer B recovery should remember')
        )
      })

      const recoverySummaries = listSystemMessages(server.dataDir, 'system_recovery_summary')
      expect(recoverySummaries).toHaveLength(1)
      expect(recoverySummaries).toContainEqual(
        expect.objectContaining({ type: 'system_recovery_summary', worker_id: alice.id })
      )
      expect(recoverySummaries.at(-1)?.text).toContain('请继续修复 restart bug')
      expect(recoverySummaries.at(-1)?.text).toContain('layer b fallback')
      expect(recoverySummaries.at(-1)?.text).toContain('Bob')
      expect(recoverySummaries.at(-1)?.text).toContain(
        'Layer B recovery should remember the relay debug decision.'
      )
      await waitFor(() => {
        expect(listMemoryInjections(server.dataDir)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              context_type: 'recovery',
              memory_id: recoveryMemory.id,
              target_agent_id_snapshot: alice.id,
              workspace_id: workspace.id,
            }),
          ])
        )
      })
      server.store.writeRunInput(secondRun.runId, '__HIVE_TEST_EXIT__\r')
      await waitFor(async () => {
        expect((await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)).status).toBe('exited')
      })
      await stopRunViaHttp(server.baseUrl, cookie, bobRun.runId)
    } finally {
      await server.close()
    }
  }, 15_000)

  test('orchestrator recovery summary includes old unresolved pending task details', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-layer-b-pending-home-'))
    const workspacePathRaw = join(root, 'workspace')
    tempDirs.push(root)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    const orchestratorScript = writeEchoAgent(workspacePath, 'orch-pending-echo.js')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const bob = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id, 'Bob', 'tester')
      server.store.addMemoryEntry({
        actor: { id: orchestratorId(workspace.id), name: 'Orchestrator', role: 'orchestrator' },
        body: 'Disabled recovery memory must not be injected.',
        kind: 'fact',
        workspaceId: workspace.id,
      })
      server.store.settings.setAppState(
        workspaceMemoryEnabledKey(workspace.id),
        serializeWorkspaceMemoryEnabled(false)
      )

      await server.store.dispatchTask(workspace.id, bob.id, '审查 Phase 3 SSE schema 缺口')

      const db = new Database(join(server.dataDir, 'runtime.sqlite'))
      db.prepare("UPDATE messages SET created_at = ? WHERE type = 'send' AND worker_id = ?").run(
        Date.now() - 2 * 60 * 60 * 1000,
        bob.id
      )
      db.close()

      await configureWorkerViaHttp(
        server.baseUrl,
        cookie,
        workspace.id,
        orchestratorId(workspace.id),
        {
          command: process.execPath,
          args: [orchestratorScript],
        }
      )

      const firstRun = await startWorkerViaHttp(
        server.baseUrl,
        cookie,
        workspace.id,
        orchestratorId(workspace.id)
      )
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.output).toContain('ARGS:')
      })
      await waitForPtyOutputFlush()
      server.store.writeRunInput(firstRun.runId, '__HIVE_TEST_EXIT__\r')
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('exited')
      })

      const secondRun = await startWorkerViaHttp(
        server.baseUrl,
        cookie,
        workspace.id,
        orchestratorId(workspace.id)
      )
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain('## Open tasks')
        expect(state.output).toContain('Bob')
        expect(state.output).toContain('审查 Phase 3 SSE schema 缺口')
        expect(state.output).not.toContain('<hive-memory context="recovery">')
        expect(state.output).not.toContain('Disabled recovery memory must not be injected.')
      })
      expect(listMemoryInjections(server.dataDir)).toEqual([])
      server.store.writeRunInput(secondRun.runId, '__HIVE_TEST_EXIT__\r')
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('exited')
      })
    } finally {
      await server.close()
    }
  }, 25_000)

  test('resume failure falls back to Layer B on the next start instead of restarting blank', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-layer-b-failure-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(homeDir, '.claude', 'projects')
    const fakeClaude = writeResumableClaudeEcho(workspacePath)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const alice = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id, 'Alice')
      const bob = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id, 'Bob', 'tester')
      const bobScript = writeEchoAgent(workspacePath, 'bob-passive.js')
      const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

      await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/tasks`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ content: '# Tasks\n- [ ] recover after failed resume\n' }),
      })
      server.store.recordUserInput(
        workspace.id,
        orchestratorId(workspace.id),
        '恢复后检查 Layer B 摘要'
      )
      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id, {
        command: process.execPath,
        args: [bobScript],
      })
      const bobRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id)
      await waitForRunOutput(server.baseUrl, cookie, bobRun.runId, 'ARGS:')

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id, {
        command: fakeClaude,
        args: ['--session-id-test', sessionId],
        command_preset_id: 'claude',
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, alice.id)).toBe(sessionId)
      })
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.output).toContain('[Pasted text #1 +1 lines]')
      })
      server.store.writeRunInput(firstRun.runId, '__HIVE_TEST_EXIT__\r')
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('exited')
      })

      writeFileSync(join(workspacePath, '.fail-next-resume'), '1\n')
      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('error')
      })
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, alice.id)).toBeUndefined()
      })

      rmSync(join(workspacePath, '.fail-next-resume'), { force: true })
      const summariesBeforeFallback = listSystemMessages(server.dataDir, 'system_recovery_summary')
      // A native resume now attempts current-ledger synchronization. Its failed
      // process may have accepted that write before exiting; it is not a blank restart.
      for (const summary of summariesBeforeFallback) {
        expect(summary.worker_id).toBe(alice.id)
        expect(summary.text).toContain('Your native session resumed')
      }
      const pending = await server.store.dispatchTask(
        workspace.id,
        alice.id,
        'Verify retained fallback responsibility'
      )

      const thirdRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, thirdRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).not.toContain('--resume')
        expect(state.output).toContain('<hive-system-message>')
        if (process.platform !== 'win32') {
          expect(state.output).toContain('STDIN:\u001b[200~<hive-system-message>')
          expect(state.output).toContain('\u001b[201~')
        }
        expect(state.output).toContain('recover after failed resume')
        expectOutputToContainTerminalText(state.output, '恢复后检查 Layer B 摘要')
        expect(state.output).toContain('Bob')
        const recoveryEnvelope = state.output.match(
          /<hive-system-message>[\s\S]*?<\/hive-system-message>/
        )?.[0]
        expect(recoveryEnvelope).toBeDefined()
        expect(recoveryEnvelope).toContain(pending.id)
        expect(recoveryEnvelope).toContain('Verify retained fallback responsibility')
      })

      const recoverySummaries = listSystemMessages(server.dataDir, 'system_recovery_summary')
      // A failed native synchronization can roll back asynchronously. Identify
      // the successful fallback by the responsibility added after that failure.
      expect(recoverySummaries.filter((summary) => summary.text.includes(pending.id))).toHaveLength(
        1
      )
      expect(recoverySummaries.at(-1)?.text).toContain(pending.id)
      expect(recoverySummaries).toContainEqual(
        expect.objectContaining({
          type: 'system_recovery_summary',
          worker_id: alice.id,
          text: expect.stringContaining('recover after failed resume'),
        })
      )
      server.store.writeRunInput(thirdRun.runId, '__FALLBACK_ACCEPTS_NEW_INPUT__\r')
      await waitForRunOutput(
        server.baseUrl,
        cookie,
        thirdRun.runId,
        'STDIN:__FALLBACK_ACCEPTS_NEW_INPUT__'
      )
      server.store.writeRunInput(thirdRun.runId, '__HIVE_TEST_EXIT__\r')
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, thirdRun.runId)
        expect(state.status).toBe('exited')
      })
      await stopRunViaHttp(server.baseUrl, cookie, bobRun.runId)
    } finally {
      await server.close()
    }
  }, 25_000)
})
