import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

const runTeamBinary = promisify(execFile)

const tempDirs: string[] = []
const originalEnv = { ...process.env }

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 2000,
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

afterEach(() => {
  process.env = { ...originalEnv }
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('team send CLI side effects (R1.3)', () => {
  test('team send injects prompt into worker stdin, records message, bumps pending count, and binds reporting to its dispatch', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-cli-side-effects-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const workerScript = join(workspacePath, 'worker-echo.js')
    writeFileSync(
      workerScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => process.stdout.write('WRK:' + chunk))",
      ].join('\n')
    )
    const orchScript = join(workspacePath, 'orch-passive.js')
    writeFileSync(orchScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      const configure = async (agentId: string, scriptPath: string) =>
        fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: process.execPath,
            args: [scriptPath],
          }),
        })
      const startAgent = async (agentId: string) =>
        fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        })

      await configure(orchestratorId, orchScript)
      await configure(worker.id, workerScript)
      const orchStart = await startAgent(orchestratorId)
      expect(orchStart.status).toBe(201)
      const workerStart = await startAgent(worker.id)
      expect(workerStart.status).toBe(201)

      const orchToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      process.env = {
        ...originalEnv,
        HIVE_DATA_DIR: dataDir,
        HIVE_AGENT_ID: orchestratorId,
        HIVE_AGENT_TOKEN: orchToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }

      await runTeamCommand(['send', 'Alice', '实现登录'])

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
          headers: { cookie: uiCookie },
        })
        expect(runResponse.status).toBe(200)
        const team = (await runResponse.json()) as Array<{
          id: string
          pending_task_count: number
          status: string
        }>
        const aliceRow = team.find((item) => item.id === worker.id)
        expect(aliceRow?.pending_task_count).toBe(1)
        expect(aliceRow?.status).toBe('working')
      })

      const dispatch = hive.store.listDispatches(workspace.id)[0]
      expect(dispatch?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      await waitFor(async () => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(run?.output).toContain('WRK:')
        expect(run?.output).toContain('@Orchestrator')
        expect(run?.output).toContain('Hive member; keep your assigned role and scope')
        expect(run?.output).toContain('实现登录')
        expect(run?.output).toContain(`dispatch_id: ${dispatch?.id}`)
        expect(run?.output).toContain(
          `team report --dispatch ${dispatch?.id} --seen <required_seen_seq> --stdin`
        )
      })

      const messages = hive.store.listMessagesForRecovery(workspace.id, 0)
      const sendMessage = messages.find((item) => item.type === 'send' && item.text === '实现登录')
      expect(sendMessage).toBeDefined()
      if (sendMessage && sendMessage.type === 'send') {
        expect(sendMessage.to).toBe(worker.id)
        expect(sendMessage.from).toBe(orchestratorId)
      }
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  }, 20_000)

  test('team send starts a configured stopped worker and delivers repeated sends', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-cli-stopped-queue-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const workerScript = join(workspacePath, 'worker-autostart-echo.js')
    writeFileSync(
      workerScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdout.write('WORKER_READY\\n')",
        "process.stdin.on('data', (chunk) => process.stdout.write('WRK:' + chunk))",
      ].join('\n')
    )
    const orchScript = join(workspacePath, 'orch-passive.js')
    writeFileSync(orchScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'AutoStart',
          path: workspacePath,
        }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      const configure = async (agentId: string, scriptPath: string) =>
        fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: process.execPath,
            args: [scriptPath],
          }),
        })
      const startAgent = async (agentId: string) =>
        fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        })

      await configure(orchestratorId, orchScript)
      await configure(worker.id, workerScript)
      const orchStart = await startAgent(orchestratorId)
      expect(orchStart.status).toBe(201)
      expect(hive.store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()

      const orchToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      process.env = {
        ...originalEnv,
        HIVE_DATA_DIR: dataDir,
        HIVE_AGENT_ID: orchestratorId,
        HIVE_AGENT_TOKEN: orchToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }

      const send = (text: string) =>
        runTeamBinary(process.execPath, ['--import', 'tsx', 'bin/team', 'send', 'Alice', text])
      const [first, second] = await Promise.all([send('评估项目结构'), send('第二次任务')])
      expect(JSON.parse(first.stdout)).toEqual(expect.objectContaining({ ok: true }))
      expect(JSON.parse(second.stdout)).toEqual(expect.objectContaining({ ok: true }))
      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(run?.output).toContain('评估项目结构')
        expect(run?.output).toContain('第二次任务')
        expect(
          hive.store.listDispatches(workspace.id).filter((item) => item.deliveredAt !== null)
        ).toHaveLength(2)
      }, 10_000)
      expect(hive.store.listAgentRuns(worker.id)).toHaveLength(1)
      const dispatches = hive.store.listDispatches(workspace.id)
      expect(dispatches.map((item) => item.text).sort()).toEqual(
        ['第二次任务', '评估项目结构'].sort()
      )
      const missing = await runTeamBinary(process.execPath, [
        '--import',
        'tsx',
        'bin/team',
        'send',
        'Missing',
        'task',
      ]).then(
        () => null,
        (error: unknown) => error
      )
      expect(missing).toEqual(expect.objectContaining({ code: 1 }))
      expect(hive.store.listDispatches(workspace.id)).toHaveLength(2)

      const unconfiguredResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/workers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ name: 'Unconfigured', role: 'coder' }),
        }
      )
      const unconfigured = (await unconfiguredResponse.json()) as { id: string }
      const queued = await runTeamBinary(process.execPath, [
        '--import',
        'tsx',
        'bin/team',
        'send',
        'Unconfigured',
        'task',
      ])
      expect(JSON.parse(queued.stdout)).toEqual(
        expect.objectContaining({ ok: true, queued: true, worker_status: 'stopped' })
      )
      expect(hive.store.getActiveRunByAgentId(workspace.id, unconfigured.id)).toBeUndefined()
      expect(hive.store.listDispatches(workspace.id)).toHaveLength(3)

      const badConfig = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${unconfigured.id}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ command: join(workspacePath, 'missing-executable'), args: [] }),
        }
      )
      expect(badConfig.status).toBe(204)
      const badStart = await runTeamBinary(process.execPath, [
        '--import',
        'tsx',
        'bin/team',
        'send',
        'Unconfigured',
        'bad start',
      ]).then(
        () => null,
        (error: unknown) => error
      )
      expect(badStart).toEqual(expect.objectContaining({ code: 1 }))
      expect(hive.store.getActiveRunByAgentId(workspace.id, unconfigured.id)).toBeUndefined()
      expect(hive.store.getWorker(workspace.id, unconfigured.id)).toEqual(
        expect.objectContaining({ status: 'stopped', pendingTaskCount: 1 })
      )
      expect(hive.store.listDispatches(workspace.id)).toHaveLength(3)

      expect((await configure(unconfigured.id, workerScript)).status).toBe(204)
      const recovery = await runTeamBinary(process.execPath, [
        '--import',
        'tsx',
        'bin/team',
        'send',
        'Unconfigured',
        'new after configuration',
      ])
      expect(JSON.parse(recovery.stdout)).toEqual(
        expect.objectContaining({ ok: true, restarted_worker: true })
      )
      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, unconfigured.id)
        expect(run?.output).toContain('task')
        expect(run?.output).toContain('new after configuration')
        const delivered = hive.store
          .listDispatches(workspace.id)
          .filter((item) => item.toAgentId === unconfigured.id && item.deliveredAt !== null)
        expect(delivered.map((item) => item.text).sort()).toEqual(
          ['task', 'new after configuration'].sort()
        )
      }, 10_000)
      expect(hive.store.listAgentRuns(unconfigured.id)).toHaveLength(1)
    } finally {
      delete process.env.HIVE_DATA_DIR
      await hive.close()
    }
  }, 20_000)
})
