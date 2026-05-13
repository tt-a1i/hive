import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { getClaudeSessionFilePath } from '../../src/server/session-capture-claude.js'
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

const readLastSessionId = (dataDir: string, workspaceId: string, agentId: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
  const row = db
    .prepare('SELECT last_session_id FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?')
    .get(workspaceId, agentId) as { last_session_id: string } | undefined
  db.close()
  return row?.last_session_id
}

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
const encoded = process.cwd().replace(/[\\/:\\s]/g, '-')
const projectsRoot = process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
const projectDir = join(projectsRoot, encoded)
const failMarker = join(process.cwd(), '.fail-next-resume')
const expectFreshMarker = join(process.cwd(), '.expect-fresh')
const expectResumeMarker = join(process.cwd(), '.expect-resume')
mkdirSync(projectDir, { recursive: true })
const sessionPath = join(projectDir, sessionId + '.jsonl')
writeFileSync(sessionPath, '{}\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  process.stdout.write('STDIN:' + chunk)
  appendFileSync(sessionPath, JSON.stringify({ message: { role: 'user', content: chunk } }) + '\\n')
  if (chunk.includes('\\u001b[201~')) process.stdout.write('\\n[Pasted text #1 +1 lines]\\n')
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
  return cliPath
}

const createWorkspaceViaHttp = async (baseUrl: string, cookie: string, workspacePath: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
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
  return (await response.json()) as { runId: string }
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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('Layer A resume recovery integration', () => {
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
  })

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
  })

  test('T3 resume failure: non-zero resumed start clears session id and next start is bare', async () => {
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
        expect(readLastSessionId(server.dataDir, workspace.id, worker.id)).toBeUndefined()
      })

      unlinkSync(join(workspacePath, '.fail-next-resume'))
      writeFileSync(join(workspacePath, '.expect-fresh'), '1\n')

      const thirdRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const run = await getRunOutputViaHttp(server.baseUrl, cookie, thirdRun.runId)
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
  }, 10_000)
})
