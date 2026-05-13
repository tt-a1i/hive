import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
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

describe('hive cli end to end', () => {
  test('CLI autostarts persisted orchestrator and members on runtime restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-restart-autostart-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const scriptPath = join(workspacePath, 'steady-agent.js')
    writeFileSync(
      scriptPath,
      [
        "console.log('AGENT=' + process.env.HIVE_AGENT_ID)",
        "console.log('PORT=' + process.env.HIVE_PORT)",
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )

    const setupStore = createRuntimeStore({ dataDir })
    const workspace = setupStore.createWorkspace(workspacePath, 'Persisted')
    const orchestratorId = `${workspace.id}:orchestrator`
    const worker = setupStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    for (const agentId of [orchestratorId, worker.id]) {
      setupStore.configureAgentLaunch(workspace.id, agentId, {
        args: [scriptPath],
        command: process.execPath,
      })
    }
    await setupStore.close()

    const originalDataDir = process.env.HIVE_DATA_DIR
    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)

      await waitFor(async () => {
        const runsResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/runs`, {
          headers: { cookie: uiCookie },
        })
        expect(runsResponse.status).toBe(200)
        const runs = (await runsResponse.json()) as Array<{
          agent_id: string
          run_id: string
          status: string
        }>
        expect(runs.map((run) => run.agent_id).sort()).toEqual([orchestratorId, worker.id].sort())
        expect(runs.every((run) => run.status === 'running' || run.status === 'starting')).toBe(
          true
        )

        for (const run of runs) {
          const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${run.run_id}`, {
            headers: { cookie: uiCookie },
          })
          expect(runResponse.status).toBe(200)
          const state = (await runResponse.json()) as { output: string }
          expect(state.output).toContain(`AGENT=${run.agent_id}`)
          expect(state.output).toContain(`PORT=${hive.port}`)
        }
      })
    } finally {
      if (originalDataDir === undefined) delete process.env.HIVE_DATA_DIR
      else process.env.HIVE_DATA_DIR = originalDataDir
      await hive.close()
    }
  }, 10_000)

  test('real hive runtime can start and stop an agent over HTTP', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-e2e-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    const originalNoColor = process.env.NO_COLOR
    const originalForceColor = process.env.FORCE_COLOR

    const scriptPath = join(workspacePath, 'echo-agent.js')
    writeFileSync(
      scriptPath,
      [
        "console.log('TERM=' + (process.env.TERM ?? ''))",
        "console.log('COLORTERM=' + (process.env.COLORTERM ?? ''))",
        "console.log('NO_COLOR=' + (process.env.NO_COLOR ?? ''))",
        "console.log('FORCE_COLOR=' + (process.env.FORCE_COLOR ?? ''))",
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )

    process.env.HIVE_DATA_DIR = dataDir
    process.env.NO_COLOR = '1'
    delete process.env.FORCE_COLOR
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)

      const listBefore = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie: uiCookie } })
      expect(listBefore.status).toBe(200)

      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const configResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `"${process.execPath}" "${scriptPath}"`],
          }),
        }
      )
      expect(configResponse.status).toBe(204)

      const teamResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
        headers: { cookie: uiCookie },
      })
      expect(teamResponse.status).toBe(200)

      const startResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )

      if (startResponse.status !== 201) {
        throw new Error(`start failed: ${await startResponse.text()}`)
      }
      expect(startResponse.status).toBe(201)
      const startPayload = (await startResponse.json()) as { runId: string }

      const runResponse = await fetch(`${baseUrl}/api/runtime/runs/${startPayload.runId}`, {
        headers: { cookie: uiCookie },
      })
      expect(runResponse.status).toBe(200)
      const run = (await runResponse.json()) as { output: string }
      await waitFor(async () => {
        const stateResponse = await fetch(`${baseUrl}/api/runtime/runs/${startPayload.runId}`, {
          headers: { cookie: uiCookie },
        })
        const state = (await stateResponse.json()) as { output: string }
        expect(state.output).toContain('TERM=xterm-256color')
        expect(state.output).toContain('COLORTERM=truecolor')
        expect(state.output).toContain('NO_COLOR=')
        expect(state.output).not.toContain('NO_COLOR=1')
        expect(state.output).toContain('FORCE_COLOR=1')
      })
      expect(run.output).toEqual(expect.any(String))

      const stopResponse = await fetch(`${baseUrl}/api/runtime/runs/${startPayload.runId}/stop`, {
        method: 'POST',
        headers: { cookie: uiCookie },
      })

      expect(stopResponse.status).toBe(202)
    } finally {
      delete process.env.HIVE_DATA_DIR
      if (originalNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = originalNoColor
      if (originalForceColor === undefined) delete process.env.FORCE_COLOR
      else process.env.FORCE_COLOR = originalForceColor
      await hive.close()
    }
  })

  test('CLI uses a default SQLite data dir so builtin orchestrator config is seeded', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hive-default-home-'))
    const workspacePath = join(homeDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(homeDir)

    const childEnv = { ...process.env }
    delete childEnv.HIVE_DATA_DIR
    delete childEnv.HIVE_ORCHESTRATOR_ARGS_JSON
    delete childEnv.HIVE_ORCHESTRATOR_COMMAND
    const { spawn } = await import('node:child_process')
    const modulePath = new URL('../../src/cli/hive.ts', import.meta.url)
    const processHandle = spawn(
      process.execPath,
      ['--import', 'tsx', modulePath.pathname, '--port', '0'],
      {
        env: { ...childEnv, HOME: homeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let stdout = ''
    processHandle.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    try {
      await waitFor(() => {
        expect(stdout).toContain('Hive running at http://127.0.0.1:')
      })
      const match = stdout.match(/Hive running at http:\/\/127\.0\.0\.1:(\d+)/)
      expect(match?.[1]).toBeTruthy()
      const baseUrl = `http://127.0.0.1:${Number(match?.[1])}`
      const uiCookie = await getUiCookie(baseUrl)

      const templatesResponse = await fetch(`${baseUrl}/api/settings/role-templates`, {
        headers: { cookie: uiCookie },
      })
      expect(templatesResponse.status).toBe(200)
      const templates = (await templatesResponse.json()) as Array<{
        default_args: string[]
        default_command: string
        default_env: Record<string, string>
        description: string
        id: string
        name: string
        role_type: string
      }>
      const orchestrator = templates.find((template) => template.role_type === 'orchestrator')
      expect(orchestrator?.id).toBe('orchestrator')
      expect(orchestrator?.default_command).toBe('claude')

      const response = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'DefaultConfig',
          path: workspacePath,
        }),
      })

      expect(response.status).toBe(201)
      const body = (await response.json()) as {
        orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
      }
      expect(body.orchestrator_start).toEqual({
        ok: false,
        error: null,
        run_id: null,
      })
      expect(existsSync(join(homeDir, '.config', 'hive', 'runtime.sqlite'))).toBe(true)
    } finally {
      processHandle.kill('SIGTERM')
      await new Promise<void>((resolve) => processHandle.once('exit', () => resolve()))
    }
  })
})
