import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalClaudeProjectsDir = process.env.HIVE_CLAUDE_PROJECTS_DIR
const originalCodexHome = process.env.CODEX_HOME
const originalGeminiHome = process.env.HIVE_GEMINI_HOME
const originalOpenCodeDbPath = process.env.HIVE_OPENCODE_DB_PATH
const originalPath = process.env.PATH

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 10_000,
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

const readLastSessionId = (dataDir: string, workspaceId: string, agentId: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
  const row = db
    .prepare('SELECT last_session_id FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?')
    .get(workspaceId, agentId) as { last_session_id: string } | undefined
  db.close()
  return row?.last_session_id
}

const readConfiguredPresetId = (dataDir: string, workspaceId: string, agentId: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
  const row = db
    .prepare(
      'SELECT command_preset_id FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?'
    )
    .get(workspaceId, agentId) as { command_preset_id: string | null } | undefined
  db.close()
  return row?.command_preset_id
}

const writeFakeCli = (workspacePath: string, name: string, source: string) => {
  const binDir = join(workspacePath, 'bin')
  mkdirSync(binDir, { recursive: true })
  const scriptPath = join(binDir, `${name}-fake.mjs`)
  writeFileSync(scriptPath, source)
  const unixCli = join(binDir, name)
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)
  const winCli = join(binDir, `${name}.cmd`)
  writeFileSync(winCli, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`)
  return process.platform === 'win32' ? winCli : unixCli
}

const writeFakeClaude = (workspacePath: string) => {
  return writeFakeCli(
    workspacePath,
    'claude',
    `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '11111111-1111-4111-8111-111111111111'
const encoded = process.cwd().replace(/[^A-Za-z0-9-]/g, '-')
const projectsRoot = process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
const projectDir = join(projectsRoot, encoded)
const expectFreshMarker = join(process.cwd(), '.expect-fresh')
const expectResumeMarker = join(process.cwd(), '.expect-resume')
const expectYoloMarker = join(process.cwd(), '.expect-yolo')
const expectNoYoloMarker = join(process.cwd(), '.expect-no-yolo')
mkdirSync(projectDir, { recursive: true })
const sessionPath = join(projectDir, sessionId + '.jsonl')
writeFileSync(sessionPath, '{}\\n')
let pasteOpen = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  process.stdout.write('STDIN:' + chunk)
  appendFileSync(sessionPath, JSON.stringify({ message: { role: 'user', content: chunk } }) + '\\n')
  if (chunk.includes('\\u001b[200~') || chunk.includes('<hive-message') || chunk.includes('<hive-system-message')) pasteOpen = true
  if (chunk.includes('\\u001b[201~') || (process.platform === 'win32' && pasteOpen && (chunk.includes('</hive-message>') || chunk.includes('</hive-system-message>')))) {
    pasteOpen = false
    process.stdout.write('\\n[Pasted text #1 +1 lines]\\n')
  }
})
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
if (existsSync(expectResumeMarker) && !args.includes('--resume')) process.exit(2)
if (existsSync(expectFreshMarker) && args.includes('--resume')) process.exit(3)
if (existsSync(expectYoloMarker) && !args.includes('--dangerously-skip-permissions')) process.exit(4)
if (existsSync(expectNoYoloMarker) && args.includes('--dangerously-skip-permissions')) process.exit(5)
process.stdout.write('❯ ')
setInterval(() => {}, 1000)
`
  )
}

const writeFakeCodex = (workspacePath: string) => {
  return writeFakeCli(
    workspacePath,
    'codex',
    `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '019dc277-0e8e-75c1-9794-94929426288e'
const delayIndex = args.indexOf('--session-write-delay-ms-test')
const writeDelayMs = delayIndex >= 0 ? Number.parseInt(args[delayIndex + 1] ?? '0', 10) : 0
const expectYoloMarker = join(process.cwd(), '.expect-yolo')
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const sessionDir = join(codexHome, 'sessions', '2026', '04', '30')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  process.stdout.write('STDIN:' + chunk)
  if (chunk.includes('\\u001b[201~') || (process.platform === 'win32' && chunk.includes('<hive-message') && chunk.includes('</hive-message>'))) {
    process.stdout.write('\\n[Pasted text #1 +1 lines]\\n')
  }
})
mkdirSync(sessionDir, { recursive: true })
const writeSession = () => writeFileSync(
    join(sessionDir, 'rollout-2026-04-30T00-00-00-' + sessionId + '.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: process.cwd() } }) + '\\n'
  )
if (writeDelayMs > 0) setTimeout(writeSession, writeDelayMs)
else writeSession()
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
const resumeIndex = args.indexOf('resume')
if (existsSync(join(process.cwd(), '.expect-resume')) && !(resumeIndex >= 0 && args[resumeIndex + 1] === sessionId)) process.exit(2)
if (existsSync(expectYoloMarker) && !args.includes('--dangerously-bypass-approvals-and-sandbox')) process.exit(4)
process.stdout.write('❯ ')
setInterval(() => {}, 1000)
`
  )
}

const writeFakeGemini = (workspacePath: string) => {
  return writeFakeCli(
    workspacePath,
    'gemini',
    `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '29405746-aa9b-40bf-961b-f3d77fdcda40'
const expectYoloMarker = join(process.cwd(), '.expect-yolo')
const geminiHome = process.env.HIVE_GEMINI_HOME ?? join(homedir(), '.gemini')
const projectDir = join(geminiHome, 'tmp', 'hive-test-project')
mkdirSync(join(projectDir, 'chats'), { recursive: true })
writeFileSync(join(projectDir, '.project_root'), process.cwd() + '\\n')
writeFileSync(join(projectDir, 'chats', 'session-2026-04-30T00-00-29405746.json'), JSON.stringify({ sessionId }))
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
if (existsSync(join(process.cwd(), '.expect-resume')) && !(args.includes('--resume') && args.includes(sessionId))) process.exit(2)
if (existsSync(expectYoloMarker) && !args.includes('--yolo')) process.exit(4)
setInterval(() => {}, 1000)
`
  )
}

const writeFakeOpenCode = (workspacePath: string) => {
  return writeFakeCli(
    workspacePath,
    'opencode',
    `#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { DatabaseSync as Database } from 'node:sqlite'
const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : 'ses_25c8f572efferzSV4Mgjo99WqB'
const expectYoloMarker = process.cwd() + '/.expect-yolo'
const db = new Database(process.env.HIVE_OPENCODE_DB_PATH)
db.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_archived INTEGER)')
db.prepare('INSERT OR REPLACE INTO session (id, directory, time_archived) VALUES (?, ?, NULL)').run(sessionId, process.cwd())
db.close()
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
if (existsSync(process.cwd() + '/.expect-resume') && !(args.includes('--session') && args.includes(sessionId))) process.exit(2)
if (existsSync(expectYoloMarker) && args.includes('--dangerously-skip-permissions')) process.exit(4)
setInterval(() => {}, 1000)
`
  )
}

const writeFakeHermes = (workspacePath: string) => {
  return writeFakeCli(
    workspacePath,
    'hermes',
    `#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '20260602_140311_be67e0'
const resumeIndex = args.indexOf('--resume')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  process.stdout.write('STDIN:' + chunk)
})
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
process.stdout.write('Session: ' + sessionId + '\\n')
if (existsSync(join(process.cwd(), '.expect-resume')) && !(resumeIndex >= 0 && args[resumeIndex + 1] === sessionId)) process.exit(2)
if (existsSync(join(process.cwd(), '.expect-yolo')) && !args.includes('--yolo')) process.exit(4)
process.stdout.write('❯ ')
setInterval(() => {}, 1000)
`
  )
}

const createWorkspaceViaHttp = async (baseUrl: string, cookie: string, workspacePath: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  return (await response.json()) as { id: string }
}

const createWorkerViaHttp = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  name = 'Alice'
) => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name, role: 'coder' }),
  })
  return (await response.json()) as { id: string }
}

const renameWorkerViaHttp = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string,
  workerId: string,
  name: string
) => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers/${workerId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  })
  expect(response.status).toBe(200)
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

const writePersistedSessionId = (
  dataDir: string,
  workspaceId: string,
  agentId: string,
  sessionId: string
) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
         last_session_id = excluded.last_session_id,
         updated_at = excluded.updated_at`
    ).run(agentId, workspaceId, sessionId, Date.now())
    db.prepare('UPDATE workers SET last_session_id = ? WHERE id = ? AND workspace_id = ?').run(
      sessionId,
      agentId,
      workspaceId
    )
  })()
  db.close()
}

afterEach(() => {
  if (originalClaudeProjectsDir === undefined) {
    delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  } else {
    process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir
  }
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalGeminiHome === undefined) delete process.env.HIVE_GEMINI_HOME
  else process.env.HIVE_GEMINI_HOME = originalGeminiHome
  if (originalOpenCodeDbPath === undefined) delete process.env.HIVE_OPENCODE_DB_PATH
  else process.env.HIVE_OPENCODE_DB_PATH = originalOpenCodeDbPath
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('preset-driven Layer A', () => {
  test('bound claude preset injects yolo args on fresh start', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-preset-layer-a-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(homeDir, '.claude', 'projects')
    const fakeClaude = writeFakeClaude(workspacePath)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id, {
        command: fakeClaude,
        args: ['--session-id-test', sessionId],
        command_preset_id: 'claude',
      })
      expect(readConfiguredPresetId(server.dataDir, workspace.id, worker.id)).toBe('claude')
      writeFileSync(join(workspacePath, '.expect-yolo'), '1\n')

      const run = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, run.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain(
          `ARGS:--dangerously-skip-permissions --permission-mode=bypassPermissions --disallowedTools=Task --session-id-test ${sessionId}`
        )
      })
    } finally {
      await server.close()
    }
  })

  test('bound claude preset captures and reuses session id on restart', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-preset-layer-a-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(homeDir, '.claude', 'projects')
    const fakeClaude = writeFakeClaude(workspacePath)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id, {
        command: fakeClaude,
        args: ['--session-id-test', sessionId],
        command_preset_id: 'claude',
      })
      expect(readConfiguredPresetId(server.dataDir, workspace.id, worker.id)).toBe('claude')

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })

      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('exited')
      })

      await renameWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id, 'Alice Renamed')
      writeFileSync(join(workspacePath, '.expect-resume'), '1\n')
      writeFileSync(join(workspacePath, '.expect-yolo'), '1\n')

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain(
          `ARGS:--dangerously-skip-permissions --permission-mode=bypassPermissions --disallowedTools=Task --resume ${sessionId} --session-id-test ${sessionId}`
        )
      })
    } finally {
      await server.close()
    }
  }, 15000)

  test('bound claude preset binds concurrent worker session ids by worker prompt', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-preset-layer-a-concurrent-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(homeDir, '.claude', 'projects')
    const fakeClaude = writeFakeClaude(workspacePath)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const alice = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id, 'Alice')
      const bob = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id, 'Bob')
      const bobSessionId = '11111111-1111-4111-8111-111111111111'
      const aliceSessionId = '22222222-2222-4222-8222-222222222222'

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id, {
        command: fakeClaude,
        args: ['--session-id-test', aliceSessionId],
        command_preset_id: 'claude',
      })
      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id, {
        command: fakeClaude,
        args: ['--session-id-test', bobSessionId],
        command_preset_id: 'claude',
      })

      const [aliceRun, bobRun] = await Promise.all([
        startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id),
        startWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id),
      ])

      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, alice.id)).toBe(aliceSessionId)
        expect(readLastSessionId(server.dataDir, workspace.id, bob.id)).toBe(bobSessionId)
      })

      server.store.stopAgentRun(aliceRun.runId)
      server.store.stopAgentRun(bobRun.runId)
    } finally {
      await server.close()
    }
  }, 15000)

  test('bound claude preset rejects another worker session id over HTTP', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-preset-layer-a-wrong-owner-home-'))
    const dataDir = join(homeDir, 'data')
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(homeDir, '.claude', 'projects')
    const fakeClaude = writeFakeClaude(workspacePath)
    const bobSessionId = '33333333-3333-4333-8333-333333333333'
    const aliceSessionId = '44444444-4444-4444-8444-444444444444'

    let workspaceId = ''
    let aliceId = ''
    let bobId = ''
    const firstServer = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(firstServer.baseUrl)
      const workspace = await createWorkspaceViaHttp(firstServer.baseUrl, cookie, workspacePath)
      workspaceId = workspace.id
      const alice = await createWorkerViaHttp(firstServer.baseUrl, cookie, workspace.id, 'Alice')
      const bob = await createWorkerViaHttp(firstServer.baseUrl, cookie, workspace.id, 'Bob')
      aliceId = alice.id
      bobId = bob.id

      await configureWorkerViaHttp(firstServer.baseUrl, cookie, workspace.id, alice.id, {
        command: fakeClaude,
        args: ['--session-id-test', aliceSessionId],
        command_preset_id: 'claude',
      })
      await configureWorkerViaHttp(firstServer.baseUrl, cookie, workspace.id, bob.id, {
        command: fakeClaude,
        args: ['--session-id-test', bobSessionId],
        command_preset_id: 'claude',
      })

      const bobRun = await startWorkerViaHttp(firstServer.baseUrl, cookie, workspace.id, bob.id)
      await waitFor(() => {
        expect(readLastSessionId(dataDir, workspace.id, bob.id)).toBe(bobSessionId)
      })
      firstServer.store.stopAgentRun(bobRun.runId)
    } finally {
      await firstServer.close()
    }

    writePersistedSessionId(dataDir, workspaceId, aliceId, bobSessionId)
    writeFileSync(join(workspacePath, '.expect-fresh'), '1\n')

    const secondServer = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(secondServer.baseUrl)
      const aliceRun = await startWorkerViaHttp(secondServer.baseUrl, cookie, workspaceId, aliceId)
      await waitFor(async () => {
        const state = await getRunViaHttp(secondServer.baseUrl, cookie, aliceRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain(
          `ARGS:--dangerously-skip-permissions --permission-mode=bypassPermissions --disallowedTools=Task --session-id-test ${aliceSessionId}`
        )
        expect(state.output).not.toContain('--resume')
      })
      await waitFor(() => {
        expect(readLastSessionId(dataDir, workspaceId, aliceId)).toBe(aliceSessionId)
        expect(readLastSessionId(dataDir, workspaceId, bobId)).toBe(bobSessionId)
      })
    } finally {
      await secondServer.close()
    }
  }, 15000)

  test('unbound claude command stays bare: no capture, no resume, no yolo', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-preset-layer-a-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(homeDir, '.claude', 'projects')
    const fakeClaude = writeFakeClaude(workspacePath)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id, {
        command: fakeClaude,
        args: ['--session-id-test', sessionId],
      })
      expect(readConfiguredPresetId(server.dataDir, workspace.id, worker.id)).toBeNull()
      writeFileSync(join(workspacePath, '.expect-fresh'), '1\n')
      writeFileSync(join(workspacePath, '.expect-no-yolo'), '1\n')

      const run = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, run.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain(`ARGS:--session-id-test ${sessionId}`)
        expect(state.output).not.toContain('--resume')
        expect(state.output).not.toContain('--dangerously-skip-permissions')
      })

      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  test.each([
    {
      env: (homeDir: string) => {
        process.env.CODEX_HOME = join(homeDir, '.codex')
      },
      expectedArgs: (sessionId: string) =>
        `ARGS:--dangerously-bypass-approvals-and-sandbox resume ${sessionId} --session-id-test ${sessionId}`,
      presetId: 'codex',
      sessionId: '019dc277-0e8e-75c1-9794-94929426288e',
      writeCli: writeFakeCodex,
    },
    {
      env: (homeDir: string) => {
        process.env.HIVE_GEMINI_HOME = join(homeDir, '.gemini')
      },
      expectedArgs: (sessionId: string) =>
        `ARGS:--yolo --resume ${sessionId} --session-id-test ${sessionId}`,
      presetId: 'gemini',
      sessionId: '29405746-aa9b-40bf-961b-f3d77fdcda40',
      writeCli: writeFakeGemini,
    },
    {
      env: (homeDir: string) => {
        process.env.HIVE_OPENCODE_DB_PATH = join(homeDir, 'opencode.db')
      },
      expectedArgs: (sessionId: string) =>
        `ARGS:--session ${sessionId} --session-id-test ${sessionId}`,
      presetId: 'opencode',
      sessionId: 'ses_25c8f572efferzSV4Mgjo99WqB',
      writeCli: writeFakeOpenCode,
    },
    {
      env: () => {},
      expectedArgs: (sessionId: string) =>
        `ARGS:--yolo --resume ${sessionId} --session-id-test ${sessionId}`,
      presetId: 'hermes',
      sessionId: '20260602_140311_be67e0',
      writeCli: writeFakeHermes,
    },
  ])('bound $presetId preset captures and reuses native session id on restart', async (input) => {
    const homeDir = mkdtempSync(join(tmpdir(), `hive-${input.presetId}-resume-`))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync.native(workspacePathRaw)
    input.env(homeDir)
    const fakeCli = input.writeCli(workspacePath)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id, {
        command: fakeCli,
        args: ['--session-id-test', input.sessionId],
        command_preset_id: input.presetId,
      })
      expect(readConfiguredPresetId(server.dataDir, workspace.id, worker.id)).toBe(input.presetId)
      writeFileSync(join(workspacePath, '.expect-yolo'), '1\n')

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(input.sessionId)
      })

      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('exited')
      })

      writeFileSync(join(workspacePath, '.expect-resume'), '1\n')
      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain(input.expectedArgs(input.sessionId))
      })
    } finally {
      await server.close()
    }
  }, 15000)

  test('bound codex preset trusts captured session id even when the session file is gone', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-codex-fast-resume-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync.native(workspacePathRaw)
    const codexHome = join(homeDir, '.codex')
    process.env.CODEX_HOME = codexHome
    const fakeCodex = writeFakeCodex(workspacePath)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id, {
        command: fakeCodex,
        args: ['--session-id-test', sessionId],
        command_preset_id: 'codex',
      })
      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })
      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('exited')
      })
      removeTestPath(codexHome)
      writeFileSync(join(workspacePath, '.expect-resume'), '1\n')

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain(
          `ARGS:--dangerously-bypass-approvals-and-sandbox resume ${sessionId} --session-id-test ${sessionId}`
        )
      })
    } finally {
      await server.close()
    }
  }, 15000)

  test('bound codex preset normalizes stale node.exe npm entrypoint launch configs', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-codex-node-entrypoint-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync.native(workspacePathRaw)
    process.env.CODEX_HOME = join(homeDir, '.codex')
    writeFakeCodex(workspacePath)
    process.env.PATH = `${join(workspacePath, 'bin')}${delimiter}${originalPath ?? ''}`
    const staleCodexJs = join(homeDir, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    mkdirSync(dirname(staleCodexJs), { recursive: true })
    writeFileSync(staleCodexJs, "throw new Error('stale codex npm entrypoint should not run')\n")

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id, {
        command: process.execPath,
        args: [staleCodexJs, '--session-id-test', sessionId],
        command_preset_id: 'codex',
      })
      writeFileSync(join(workspacePath, '.expect-yolo'), '1\n')

      const run = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, run.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain(
          `ARGS:--dangerously-bypass-approvals-and-sandbox --session-id-test ${sessionId}`
        )
        expect(state.output).not.toContain('bad option')
        expect(state.output).not.toContain('stale codex npm entrypoint should not run')
      })
    } finally {
      await server.close()
    }
  })

  test('bound codex preset still captures a session id created after CLI startup', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-codex-delayed-resume-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync.native(workspacePathRaw)
    process.env.CODEX_HOME = join(homeDir, '.codex')
    const fakeCodex = writeFakeCodex(workspacePath)

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = '019ddf19-d534-7eb3-8a8c-83cde4613417'

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id, {
        command: fakeCodex,
        args: ['--session-id-test', sessionId, '--session-write-delay-ms-test', '6000'],
        command_preset_id: 'codex',
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('running')
      })
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      }, 12_000)
    } finally {
      await server.close()
    }
  }, 20_000)
})
