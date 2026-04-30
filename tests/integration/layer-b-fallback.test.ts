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

const listRecoverySourceMessages = (dataDir: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
  const rows = db
    .prepare(
      "SELECT type, text FROM messages WHERE type IN ('user_input', 'send', 'report') ORDER BY sequence ASC"
    )
    .all() as Array<{ text: string; type: 'report' | 'send' | 'user_input' }>
  db.close()
  return rows
}

const readLastSessionId = (dataDir: string, workspaceId: string, agentId: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
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
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => process.stdout.write('STDIN:' + chunk))",
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  process.stdout.write('STDIN:' + chunk)
  if (chunk.includes('\\u001b[201~')) process.stdout.write('\\n[Pasted text #1 +1 lines]\\n')
})
const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session-id-test')
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '11111111-1111-4111-8111-111111111111'
const encoded = process.cwd().replace(/[\\/:\\s]/g, '-')
const projectsRoot = process.env.HIVE_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
const projectDir = join(projectsRoot, encoded)
const failMarker = join(process.cwd(), '.fail-next-resume')
mkdirSync(projectDir, { recursive: true })
writeFileSync(join(projectDir, sessionId + '.jsonl'), '{}\\n')
process.stdout.write('ARGS:' + args.join(' ') + '\\n')
if (args.includes('--resume') && existsSync(failMarker)) process.exit(1)
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

      await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/user-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ text: '让 worker 评估一下项目目标' }),
      })
      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id, {
        command: process.execPath,
        args: [bobScript],
      })
      await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id)

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
      server.store.stopAgentRun(firstRun.runId)
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
        expect(state.output).toContain('让 worker 评估一下项目目标')
        expect(state.output).toContain('Bob')
        expect(state.output).toContain('Hive worker 是右侧卡片里的真实 CLI agent')
        expect(state.output).toContain('先执行 `team list` 确认真实 Hive worker')
        expect(state.output).toContain('如果只有一个可用 worker，直接用 `team send <worker-name>')
        expect(state.output).toContain('team send <worker-name> "<task>"')
        expect(state.output).toContain('不要使用 Claude Code 内置的 Task / Explore / subagent')
      })
    } finally {
      await server.close()
    }
  })

  test('custom command restart receives Layer B summary built from messages, tasks.md and worker list', async () => {
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

      await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/tasks`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ content: '# Tasks\n- [ ] layer b fallback\n' }),
      })
      await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/user-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ text: '请继续修复 restart bug' }),
      })
      expect(listRecoverySourceMessages(server.dataDir)).toContainEqual(
        expect.objectContaining({ type: 'user_input', text: '请继续修复 restart bug' })
      )

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id, {
        command: process.execPath,
        args: [bobScript],
      })
      await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, bob.id)

      await configureWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id, {
        command: process.execPath,
        args: [aliceScript],
      })

      const firstRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      server.store.stopAgentRun(firstRun.runId)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, firstRun.runId)
        expect(state.status).toBe('exited')
      })
      expect(listSystemMessages(server.dataDir, 'system_recovery_summary')).toHaveLength(0)

      const secondRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, secondRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).toContain('STDIN:[Hive 系统消息：你是 Alpha 的')
        expect(state.output).toContain('无法通过原生 session resume 恢复')
        expect(state.output).toContain('请继续修复 restart bug')
        expect(state.output).toContain('layer b fallback')
        expect(state.output).toContain('Bob')
      })

      const recoverySummaries = listSystemMessages(server.dataDir, 'system_recovery_summary')
      expect(recoverySummaries).toHaveLength(1)
      expect(recoverySummaries).toContainEqual(
        expect.objectContaining({ type: 'system_recovery_summary', worker_id: alice.id })
      )
      expect(recoverySummaries.at(-1)?.text).toContain('请继续修复 restart bug')
      expect(recoverySummaries.at(-1)?.text).toContain('layer b fallback')
      expect(recoverySummaries.at(-1)?.text).toContain('Bob')
    } finally {
      await server.close()
    }
  })

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
      server.store.stopAgentRun(firstRun.runId)
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
        expect(state.output).toContain('## 当前未完成任务')
        expect(state.output).toContain('Bob')
        expect(state.output).toContain('审查 Phase 3 SSE schema 缺口')
      })
    } finally {
      await server.close()
    }
  }, 10_000)

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
      await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/user-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ text: '恢复后检查 Layer B 摘要' }),
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
      expect(listSystemMessages(server.dataDir, 'system_recovery_summary')).toHaveLength(0)

      const thirdRun = await startWorkerViaHttp(server.baseUrl, cookie, workspace.id, alice.id)
      await waitFor(async () => {
        const state = await getRunViaHttp(server.baseUrl, cookie, thirdRun.runId)
        expect(state.status).toBe('running')
        expect(state.output).not.toContain('--resume')
        expect(state.output).toContain('STDIN:\u001b[200~[Hive 系统消息：你是 Alpha 的')
        expect(state.output).toContain('\u001b[201~')
        expect(state.output).toContain('recover after failed resume')
        expect(state.output).toContain('恢复后检查 Layer B 摘要')
        expect(state.output).toContain('Bob')
      })

      const recoverySummaries = listSystemMessages(server.dataDir, 'system_recovery_summary')
      expect(recoverySummaries).toHaveLength(1)
      expect(recoverySummaries).toContainEqual(
        expect.objectContaining({
          type: 'system_recovery_summary',
          worker_id: alice.id,
          text: expect.stringContaining('recover after failed resume'),
        })
      )
    } finally {
      await server.close()
    }
  }, 10_000)
})
