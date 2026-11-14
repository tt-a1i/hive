import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

const runTeam = (args: string[], env: NodeJS.ProcessEnv, input?: string, keepOpen = false) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdin.on('error', () => {}) // Child may close its input as soon as the limit is exceeded.
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('team command did not exit'))
    }, 8000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    if (input) child.stdin.write(input)
    if (!keepOpen) child.stdin.end()
  })

test('CLI rejects malformed requests without settling a real dispatch or creating work', async () => {
  const originalDataDir = process.env.HIVE_DATA_DIR
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-args-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath)
  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  try {
    const base = `http://127.0.0.1:${hive.port}`
    const cookie = await getUiCookie(base)
    const post = async (path: string, body: object) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.ok).toBe(true)
      const text = await response.text()
      return text ? JSON.parse(text) : null
    }
    const workspace = (await post('/api/workspaces', {
      name: 'Args',
      path: workspacePath,
      autostart_orchestrator: false,
    })) as { id: string }
    const enabled = await fetch(`${base}/api/settings/workflow-feature`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(enabled.ok).toBe(true)
    const worker = (await post(`/api/workspaces/${workspace.id}/workers`, {
      name: 'Alice',
      role: 'coder',
    })) as { id: string }
    const orchestratorId = `${workspace.id}:orchestrator`
    for (const id of [orchestratorId, worker.id]) {
      await post(`/api/workspaces/${workspace.id}/agents/${id}/config`, {
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
      })
      await post(`/api/workspaces/${workspace.id}/agents/${id}/start`, {
        hive_port: String(hive.port),
      })
    }
    const envFor = (id: string): NodeJS.ProcessEnv => ({
      ...process.env,
      HIVE_AGENT_ID: id,
      HIVE_AGENT_TOKEN: hive.store.peekAgentToken(id) ?? '',
      HIVE_PORT: String(hive.port),
      HIVE_PROJECT_ID: workspace.id,
    })
    const sent = await runTeam(['send', 'Alice', 'Check arguments'], envFor(orchestratorId))
    expect(sent.code).toBe(0)
    const dispatch = hive.store.listDispatches(workspace.id)[0]
    expect(dispatch?.status).toBe('submitted')
    if (!dispatch) throw new Error('Expected dispatch')

    for (const args of [
      ['report', '-h'],
      ['report', 'Done', '--help'],
      ['report', '--dispatch', dispatch.id, '-h'],
    ]) {
      const result = await runTeam(args, envFor(worker.id))
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/usage/i)
      expect(hive.store.listDispatches(workspace.id)[0]).toMatchObject({
        id: dispatch.id,
        status: 'submitted',
        reportText: null,
      })
    }
    for (const args of [
      ['report', 'Done', '--bad'],
      ['report', 'Done', '--dispatch'],
      ['spawn', '--name', 'Unexpected', '--ephemral'],
      ['workflow', 'run', '--inline', 'return 1', '--bad'],
      ['workflow', 'schedule', '--cron'],
    ]) {
      const result = await runTeam(args, envFor(args[0] === 'report' ? worker.id : orchestratorId))
      expect(result.code).not.toBe(0)
      expect(result.stderr.length).toBeGreaterThan(0)
    }
    const oversized = await runTeam(
      ['report', '--stdin'],
      envFor(worker.id),
      'x'.repeat(3 * 1024 * 1024),
      true
    )
    expect(oversized.code).not.toBe(0)
    expect(oversized.stderr).toMatch(/limit|large|exceed/i)
    expect(hive.store.listDispatches(workspace.id)[0]).toMatchObject({
      status: 'submitted',
      reportText: null,
    })
    expect(
      hive.store.listMessagesForRecovery(workspace.id, 0).filter((item) => item.type === 'report')
    ).toEqual([])
    const teamResponse = await fetch(`${base}/api/ui/workspaces/${workspace.id}/team`, {
      headers: { cookie },
    })
    expect(teamResponse.ok).toBe(true)
    const team = (await teamResponse.json()) as Array<{ name: string }>
    expect(team.map((agent) => agent.name)).not.toContain('Unexpected')
    expect(hive.store.listWorkspaceWorkflowRuns(workspace.id)).toEqual([])
    expect(hive.store.listWorkspaceWorkflowSchedules(workspace.id)).toEqual([])

    const report = await runTeam(
      ['report', `--dispatch=${dispatch.id}`, '--', '--literal report'],
      envFor(worker.id)
    )
    expect(report.code, report.stderr).toBe(0)
    expect(hive.store.listDispatches(workspace.id)[0]).toMatchObject({
      id: dispatch.id,
      status: 'reported',
      reportText: '--literal report',
    })
  } finally {
    await hive.close()
    if (originalDataDir === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = originalDataDir
    removeTestPath(dataDir)
  }
}, 60000)
