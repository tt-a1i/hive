import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

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

const readConfiguredPresetId = (dataDir: string, workspaceId: string, agentId: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
  const row = db
    .prepare(
      'SELECT command_preset_id FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?'
    )
    .get(workspaceId, agentId) as { command_preset_id: string | null } | undefined
  db.close()
  return row?.command_preset_id
}

const writeFakeClaude = (workspacePath: string) => {
  const binDir = join(workspacePath, 'bin')
  mkdirSync(binDir, { recursive: true })
  const cliPath = join(binDir, 'claude')
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '11111111-1111-4111-8111-111111111111'
const encoded = process.cwd().replace(/[\\/:\\s]/g, '-')
const projectsRoot = process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
const projectDir = join(projectsRoot, encoded)
const expectFreshMarker = join(process.cwd(), '.expect-fresh')
const expectResumeMarker = join(process.cwd(), '.expect-resume')
const expectYoloMarker = join(process.cwd(), '.expect-yolo')
const expectNoYoloMarker = join(process.cwd(), '.expect-no-yolo')
mkdirSync(projectDir, { recursive: true })
writeFileSync(join(projectDir, sessionId + '.jsonl'), '{}\\n')
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
if (existsSync(expectResumeMarker) && !args.includes('--resume')) process.exit(2)
if (existsSync(expectFreshMarker) && args.includes('--resume')) process.exit(3)
if (existsSync(expectYoloMarker) && !args.includes('--dangerously-skip-permissions')) process.exit(4)
if (existsSync(expectNoYoloMarker) && args.includes('--dangerously-skip-permissions')) process.exit(5)
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
  return (await response.json()) as { runId: string }
}

const getRunViaHttp = async (baseUrl: string, cookie: string, runId: string) => {
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
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
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

      writeFileSync(join(workspacePath, '.expect-resume'), '1\n')
      writeFileSync(join(workspacePath, '.expect-yolo'), '1\n')

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, worker.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain(
          `ARGS:--resume ${sessionId} --dangerously-skip-permissions --permission-mode=bypassPermissions --disallowedTools=Task --session-id-test ${sessionId}`
        )
      })
    } finally {
      await server.close()
    }
  })

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
})
