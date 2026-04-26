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

const listSystemMessages = (
  dataDir: string,
  type: 'system_env_sync' | 'system_recovery_summary'
) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
  const rows = db
    .prepare('SELECT type, worker_id, text FROM messages WHERE type = ? ORDER BY sequence ASC')
    .all(type) as Array<{ text: string; type: string; worker_id: string }>
  db.close()
  return rows
}

const writePassiveNodeScript = (workspacePath: string, filename: string) => {
  const scriptPath = join(workspacePath, filename)
  writeFileSync(
    scriptPath,
    [
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => process.stdout.write('STDIN:' + chunk))",
      "process.stdout.write('READY\\n')",
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => process.stdout.write('STDIN:' + chunk))
const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '11111111-1111-4111-8111-111111111111'
const encoded = process.cwd().replace(/[\\/:\\s]/g, '-')
const projectsRoot = process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
const projectDir = join(projectsRoot, encoded)
const expectResumeMarker = join(process.cwd(), '.expect-resume')
mkdirSync(projectDir, { recursive: true })
writeFileSync(join(projectDir, sessionId + '.jsonl'), '{}\\n')
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
if (existsSync(expectResumeMarker) && !args.includes('--resume')) process.exit(2)
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

describe('Layer A env sync integration', () => {
  test('successful Layer A resume injects persisted env-sync system message', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-layer-a-env-sync-home-'))
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
      const bobScript = writePassiveNodeScript(workspacePath, 'bob-passive.js')
      const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

      await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/tasks`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ content: '# Tasks\n- [ ] env sync task\n' }),
      })

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id, {
        command: process.execPath,
        args: [bobScript],
      })
      await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id)

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id, {
        command: fakeClaude,
        args: ['--session-id-test', sessionId],
        command_preset_id: 'claude',
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      await waitFor(() => {
        expect(readLastSessionId(server.dataDir, workspace.id, alice.id)).toBe(sessionId)
      })

      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('exited')
      })
      expect(listSystemMessages(server.dataDir, 'system_env_sync')).toHaveLength(0)

      writeFileSync(join(workspacePath, '.expect-resume'), '1\n')

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain(`ARGS:--resume ${sessionId}`)
        expect(state.output).toContain(
          'STDIN:\u001b[200~[Hive 系统消息：你刚被 Hive 重启了。期间环境变化：'
        )
        expect(state.output).toContain('\u001b[201~')
        expect(state.output).toContain('当前 workspace: Alpha')
        expect(state.output).toContain('Bob')
        expect(state.output).toContain('env sync task')
        expect(state.output).toContain('重启期间未派新单')
      })

      const envSyncMessages = listSystemMessages(server.dataDir, 'system_env_sync')
      expect(envSyncMessages).toHaveLength(1)
      expect(envSyncMessages).toContainEqual(
        expect.objectContaining({
          type: 'system_env_sync',
          worker_id: alice.id,
          text: expect.stringContaining('env sync task'),
        })
      )
    } finally {
      await server.close()
    }
  })
})
