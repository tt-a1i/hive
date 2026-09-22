import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { getClaudeSessionFilePath } from '../../src/server/session-capture-claude.js'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalClaudeProjectsDir = process.env.HIVE_CLAUDE_PROJECTS_DIR
const originalCodexHome = process.env.CODEX_HOME

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

const CODEX_TEST_SESSION_DATE_PATH = ['2026', '07', '07'] as const
const CODEX_TEST_SESSION_FILE_PREFIX = 'rollout-2026-07-07T00-00-00-'

const getCodexSessionFilePath = (codexHome: string, sessionId: string) =>
  join(
    codexHome,
    'sessions',
    ...CODEX_TEST_SESSION_DATE_PATH,
    `${CODEX_TEST_SESSION_FILE_PREFIX}${sessionId}.jsonl`
  )

const writeFakeClaude = (workspacePath: string) => {
  const binDir = join(workspacePath, 'bin')
  mkdirSync(binDir, { recursive: true })
  const cliPath = join(binDir, 'claude')
  writeFileSync(
    cliPath,
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
const failMarker = join(process.cwd(), '.fail-next-resume')
const expectFreshMarker = join(process.cwd(), '.expect-fresh')
const expectResumeMarker = join(process.cwd(), '.expect-resume')
mkdirSync(projectDir, { recursive: true })
const sessionPath = join(projectDir, sessionId + '.jsonl')
if (!args.includes('--resume') || !existsSync(sessionPath)) {
  writeFileSync(sessionPath, '{}\\n')
}
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
if (existsSync(expectResumeMarker) && !args.includes('--resume')) {
  process.exit(2)
}
if (existsSync(expectFreshMarker) && args.includes('--resume')) {
  process.exit(3)
}
if (args.includes('--resume') && existsSync(failMarker)) {
  process.exit(1)
}
process.stdout.write('❯ ')
setInterval(() => {}, 1000)
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

const writeFakeCodex = (workspacePath: string) => {
  const binDir = join(workspacePath, 'bin')
  mkdirSync(binDir, { recursive: true })
  const cliPath = join(binDir, 'codex')
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '019dc277-0e8e-75c1-9794-94929426288e'
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const sessionDir = join(codexHome, 'sessions', ${CODEX_TEST_SESSION_DATE_PATH.map((part) => `'${part}'`).join(', ')})
const sessionPath = join(sessionDir, '${CODEX_TEST_SESSION_FILE_PREFIX}' + sessionId + '.jsonl')
const failMarker = join(process.cwd(), '.fail-next-resume')
const expectFreshMarker = join(process.cwd(), '.expect-fresh')
const expectResumeMarker = join(process.cwd(), '.expect-resume')
const isResume = args[0] === 'resume'
mkdirSync(sessionDir, { recursive: true })
if (!isResume || (!existsSync(sessionPath) && !existsSync(failMarker))) {
  writeFileSync(sessionPath, JSON.stringify({ payload: { cwd: process.cwd(), id: sessionId }, type: 'session_meta' }) + '\\n')
}
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))
let pasteOpen = false
process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  process.stdout.write('STDIN:' + chunk)
  appendFileSync(sessionPath, JSON.stringify({ message: { role: 'user', content: chunk } }) + '\\n')
  if (chunk.includes('\\u001b[200~') || chunk.includes('<hive-message') || chunk.includes('<hive-system-message')) pasteOpen = true
  if (chunk.includes('\\u001b[201~') || (process.platform === 'win32' && pasteOpen && (chunk.includes('</hive-message>') || chunk.includes('</hive-system-message>')))) {
    pasteOpen = false
    process.stdout.write('\\n[Pasted Content 10000 chars]\\n')
  }
  if (!pasteOpen && /^[\\r\\n]+$/.test(chunk)) process.stdout.write('\\nENTER_SUBMITTED\\n> ')
})
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
if (existsSync(expectResumeMarker) && !(isResume && args[1] === sessionId)) {
  process.exit(2)
}
if (existsSync(expectFreshMarker) && isResume) {
  process.exit(3)
}
if (isResume && existsSync(failMarker)) {
  process.exit(1)
}
process.stdout.write('> ')
setInterval(() => {}, 1000)
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
  return (await response.json()) as { id: string }
}

const createWorkerViaHttp = async (baseUrl: string, cookie: string, workspaceId: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  return (await response.json()) as { id: string }
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

const getRunOutputViaHttp = async (baseUrl: string, cookie: string, runId: string) => {
  const response = await fetch(`${baseUrl}/api/runtime/runs/${runId}`, { headers: { cookie } })
  expect(response.status).toBe(200)
  return (await response.json()) as { output: string; status: string }
}

afterEach(() => {
  if (originalClaudeProjectsDir === undefined) {
    delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  } else {
    process.env.HIVE_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir
  }
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  for (const dir of tempDirs.splice(0)) {
    removeTestPath(dir)
  }
})

describe('Layer A resume recovery integration', () => {
  test('T6 successful native Codex resume synchronizes the existing open dispatch and queued note', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-layer-a-open-work-'))
    tempDirs.push(homeDir)
    const workspacePathRaw = join(homeDir, 'workspace')
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync.native(workspacePathRaw)
    const codexHome = join(homeDir, '.codex')
    process.env.CODEX_HOME = codexHome
    const previousDataDir = process.env.HIVE_DATA_DIR
    process.env.HIVE_DATA_DIR = join(homeDir, 'data')
    const server = await startTestServer({ dataDir: process.env.HIVE_DATA_DIR })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          name: 'Native sync',
          path: workspacePath,
          autostart_orchestrator: false,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const orchestratorId = `${workspace.id}:orchestrator`
      const passivePath = join(workspacePath, 'controller.cjs')
      writeFileSync(
        passivePath,
        "process.stdin.resume(); process.stdin.on('data', chunk => process.stdout.write(chunk))\n"
      )
      server.store.configureAgentLaunch(workspace.id, orchestratorId, {
        command: process.execPath,
        args: [passivePath],
      })
      await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, orchestratorId)
      const sessionId = '019dc277-0e8e-75c1-9794-949294262889'
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: writeFakeCodex(workspacePath),
        args: ['--session-id-test', sessionId],
        resumeArgsTemplate: 'resume {session_id}',
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      })
      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })
      const postTeam = async (command: string, body: object, status = 202) => {
        const response = await fetch(`${server.baseUrl}/api/team/${command}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project_id: workspace.id,
            from_agent_id: orchestratorId,
            token: server.store.peekAgentToken(orchestratorId),
            ...body,
          }),
        })
        expect(response.status).toBe(status)
        return response.json()
      }
      const dispatched = (await postTeam('send', {
        to: 'Alice',
        text: 'Implement the native-resume fixture',
      })) as { dispatch_id: string }
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(run.output).toContain(dispatched.dispatch_id)
        // Wait for startup and dispatch to be submitted, not merely pasted.
        expect(run.output.match(/ENTER_SUBMITTED/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      })
      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        expect((await getRunOutputViaHttp(server.baseUrl, cookie, firstRun.runId)).status).toBe(
          'exited'
        )
      })
      const added = (await postTeam('message', {
        dispatch_id: dispatched.dispatch_id,
        kind: 'note',
        text: 'The resumed work must preserve numeric zero.',
      })) as { message: { id: string; sequence: number; delivery_state: string } }
      expect(added.message.delivery_state).toBe('queued')
      const beforeResumeInbox = (await postTeam(
        'messages',
        { dispatch_id: dispatched.dispatch_id },
        200
      )) as { required_seen_seq: number }
      expect(beforeResumeInbox.required_seen_seq).toBe(added.message.sequence)
      expect(beforeResumeInbox.required_seen_seq).toBeGreaterThan(0)

      const sessionPath = getCodexSessionFilePath(codexHome, sessionId)
      const existingSessionText = readFileSync(sessionPath, 'utf8')
      writeFileSync(join(workspacePath, '.expect-resume'), '1\n')
      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      expect(secondRun.runId).not.toBe(firstRun.runId)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(run.status).toBe('running')
        expect(run.output).toContain(`ARGS:resume ${sessionId} --session-id-test ${sessionId}`)
        const sessionText = readFileSync(sessionPath, 'utf8')
        // The fake CLI records actual stdin; a successful native resume appends to the same session.
        expect(sessionText.startsWith(existingSessionText)).toBe(true)
        const received = sessionText
          .slice(existingSessionText.length)
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { message?: { content?: string } })
          .map((record) => record.message?.content ?? '')
          .join('')
        const synchronizations = [
          ...received.matchAll(/<hive-system-message>([\s\S]*?)<\/hive-system-message>/g),
        ]
          .map((match) => match[1] ?? '')
          .filter((content) => content.includes('Your native session resumed.'))
        expect(synchronizations).toHaveLength(1)
        const synchronization = synchronizations[0] ?? ''
        // Match the synchronization envelope only: normal note/backlog delivery cannot satisfy this.
        expect(synchronization).toContain('## Open tasks (dispatch ledger)')
        expect(synchronization).toContain(
          `dispatch ${dispatched.dispatch_id} (submitted, owner ${worker.id})`
        )
        expect(synchronization).toContain(
          `dispatch ${dispatched.dispatch_id}: required_seen_seq ${beforeResumeInbox.required_seen_seq}`
        )
        expect(synchronization).toContain(
          `${added.message.id} (dispatch ${dispatched.dispatch_id}) #${added.message.sequence} note`
        )
        expect(synchronization).toContain('The resumed work must preserve numeric zero.')
        expect(received).not.toContain('<hive-message kind="dispatch"')
      })
      expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      const ledgerResponse = await fetch(
        `${server.baseUrl}/api/ui/workspaces/${workspace.id}/dispatches`,
        { headers: { cookie } }
      )
      expect(ledgerResponse.status).toBe(200)
      const ledger = (await ledgerResponse.json()) as Array<{ id: string; state: string }>
      expect(ledger).toHaveLength(1)
      expect(ledger[0]).toMatchObject({ id: dispatched.dispatch_id, state: 'submitted' })
      expect(
        server.store.listWorkers(workspace.id).find((item) => item.id === worker.id)
          ?.pendingTaskCount
      ).toBe(1)
    } finally {
      await server.close()
      if (previousDataDir === undefined) delete process.env.HIVE_DATA_DIR
      else process.env.HIVE_DATA_DIR = previousDataDir
    }
  }, 30_000)

  test('T1 happy path: captured Claude session id is reused on restart', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-layer-a-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(homeDir, '.claude', 'projects')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = '11111111-1111-4111-8111-111111111111'
      const fakeClaude = writeFakeClaude(workspacePath)

      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: fakeClaude,
        args: ['--dangerously-skip-permissions', '--session-id-test', sessionId],
        resumeArgsTemplate: '--resume {session_id}',
        sessionIdCapture: {
          pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
          source: 'claude_project_jsonl_dir',
        },
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)

      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })

      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(run.status).toBe('exited')
      })

      writeFileSync(join(workspacePath, '.expect-resume'), '1\n')

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(run.status).toBe('running')
        expect(run.output).toContain(
          `ARGS:--resume ${sessionId} --dangerously-skip-permissions --session-id-test ${sessionId}`
        )
      })
      unlinkSync(join(workspacePath, '.expect-resume'))
    } finally {
      await server.close()
    }
  }, 25_000)

  test('T2 stale session: missing Claude jsonl skips --resume', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-layer-a-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(homeDir, '.claude', 'projects')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = '22222222-2222-4222-8222-222222222222'
      const fakeClaude = writeFakeClaude(workspacePath)

      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: fakeClaude,
        args: ['--dangerously-skip-permissions', '--session-id-test', sessionId],
        resumeArgsTemplate: '--resume {session_id}',
        sessionIdCapture: {
          pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
          source: 'claude_project_jsonl_dir',
        },
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })

      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(run.status).toBe('exited')
      })

      unlinkSync(getClaudeSessionFilePath(workspacePath, sessionId))
      writeFileSync(join(workspacePath, '.expect-fresh'), '1\n')

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(run.status).toBe('running')
        expect(run.output).toContain(
          `ARGS:--dangerously-skip-permissions --session-id-test ${sessionId}`
        )
        expect(run.output).not.toContain('--resume')
      })
      unlinkSync(join(workspacePath, '.expect-fresh'))
    } finally {
      await server.close()
    }
  }, 25_000)

  test('T3 transient resume failure: non-zero resumed start keeps existing session id', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-layer-a-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync(workspacePathRaw)
    process.env.HIVE_CLAUDE_PROJECTS_DIR = join(homeDir, '.claude', 'projects')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = '33333333-3333-4333-8333-333333333333'
      const fakeClaude = writeFakeClaude(workspacePath)

      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: fakeClaude,
        args: ['--dangerously-skip-permissions', '--session-id-test', sessionId],
        resumeArgsTemplate: '--resume {session_id}',
        sessionIdCapture: {
          pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
          source: 'claude_project_jsonl_dir',
        },
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })

      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(run.status).toBe('exited')
      })

      writeFileSync(join(workspacePath, '.fail-next-resume'), '1\n')

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(run.status).toBe('error')
      })
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })

      unlinkSync(join(workspacePath, '.fail-next-resume'))
      writeFileSync(join(workspacePath, '.expect-resume'), '1\n')

      const thirdRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, thirdRun.runId)
        expect(run.status).toBe('running')
        expect(run.output).toContain(
          `ARGS:--resume ${sessionId} --dangerously-skip-permissions --session-id-test ${sessionId}`
        )
      })
      unlinkSync(join(workspacePath, '.expect-resume'))
    } finally {
      await server.close()
    }
  }, 30_000)

  test('T4 Codex transient resume failure keeps existing session id through HTTP and PTY', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-layer-a-codex-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync.native(workspacePathRaw)
    process.env.CODEX_HOME = join(homeDir, '.codex')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
      const fakeCodex = writeFakeCodex(workspacePath)

      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: fakeCodex,
        args: ['--session-id-test', sessionId],
        resumeArgsTemplate: 'resume {session_id}',
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })

      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(run.status).toBe('exited')
      })

      writeFileSync(join(workspacePath, '.fail-next-resume'), '1\n')

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(run.status).toBe('error')
      })
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })

      unlinkSync(join(workspacePath, '.fail-next-resume'))
      writeFileSync(join(workspacePath, '.expect-resume'), '1\n')

      const thirdRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, thirdRun.runId)
        expect(run.status).toBe('running')
        expect(run.output).toContain(`ARGS:resume ${sessionId} --session-id-test ${sessionId}`)
      })
      unlinkSync(join(workspacePath, '.expect-resume'))
    } finally {
      await server.close()
    }
  }, 30_000)

  test('T5 Codex stale resume failure clears missing session id through HTTP and PTY', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-layer-a-codex-home-'))
    const workspacePathRaw = join(homeDir, 'workspace')
    tempDirs.push(homeDir)
    mkdirSync(workspacePathRaw, { recursive: true })
    const workspacePath = realpathSync.native(workspacePathRaw)
    const codexHome = join(homeDir, '.codex')
    process.env.CODEX_HOME = codexHome

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspace = await createWorkspaceViaHttp(server.baseUrl, cookie, workspacePath)
      const worker = await createWorkerViaHttp(server.baseUrl, cookie, workspace.id)
      const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
      const fakeCodex = writeFakeCodex(workspacePath)

      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: fakeCodex,
        args: ['--session-id-test', sessionId],
        resumeArgsTemplate: 'resume {session_id}',
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBe(sessionId)
      })

      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(run.status).toBe('exited')
      })

      unlinkSync(getCodexSessionFilePath(codexHome, sessionId))
      writeFileSync(join(workspacePath, '.fail-next-resume'), '1\n')

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(run.status).toBe('error')
      })
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBeUndefined()
      })

      unlinkSync(join(workspacePath, '.fail-next-resume'))
      writeFileSync(join(workspacePath, '.expect-fresh'), '1\n')

      const thirdRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, thirdRun.runId)
        expect(run.status).toBe('running')
        expect(run.output).toContain(`ARGS:--session-id-test ${sessionId}`)
        expect(run.output).not.toContain('resume')
      })
      unlinkSync(join(workspacePath, '.expect-fresh'))
    } finally {
      await server.close()
    }
  }, 30_000)
})
