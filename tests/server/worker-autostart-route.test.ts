import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const restoreEnv: Array<[string, string | undefined]> = []
const tempDirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
  while (restoreEnv.length > 0) {
    const [key, value] = restoreEnv.pop() ?? ['', undefined]
    if (!key) continue
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const makeWorkspacePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-worker-autostart-'))
  tempDirs.push(dir)
  return dir
}

const createWorkspace = async (baseUrl: string, cookie: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: 'WorkerAuto',
      path: makeWorkspacePath(),
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const createCommandPreset = async (baseUrl: string, cookie: string) => {
  const response = await fetch(`${baseUrl}/api/settings/command-presets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      display_name: 'Sleeper',
      command: 'bash',
      args: ['-c', 'echo worker up; sleep 60'],
      env: {},
      resume_args_template: null,
      session_id_capture: null,
      yolo_args_template: null,
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const setEnv = (key: string, value: string | undefined) => {
  restoreEnv.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const waitFor = async (assertion: () => void, timeoutMs = 2000, intervalMs = 25) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

describe('POST /api/workspaces/:workspaceId/workers autostart', () => {
  test('creates a worker, binds the selected command preset, and starts its PTY', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server.baseUrl, cookie)
    const preset = await createCommandPreset(server.baseUrl, cookie)

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart: true,
        command_preset_id: preset.id,
        hive_port: '4010',
        name: 'Alice',
        role: 'coder',
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      agent_start: { ok: boolean; error: string | null; run_id: string | null }
      id: string
      status: string
    }
    expect(body.agent_start.ok).toBe(true)
    expect(body.agent_start.error).toBeNull()
    expect(typeof body.agent_start.run_id).toBe('string')
    expect(body.status).toBe('idle')

    const config = server.store.peekAgentLaunchConfig(workspace.id, body.id)
    expect(config).toEqual(
      expect.objectContaining({
        args: ['-c', 'echo worker up; sleep 60'],
        command: 'bash',
        commandPresetId: preset.id,
      })
    )

    const workerRun = server.store
      .listTerminalRuns(workspace.id)
      .find((run) => run.agent_id === body.id)
    expect(workerRun?.run_id).toBe(body.agent_start.run_id)
    if (workerRun) server.store.stopAgentRun(workerRun.run_id)
  })

  test('starts a worker from a full startup command through the user shell', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'hive-worker-custom-start-bin-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-worker-custom-start-'))
    tempDirs.push(binDir, dataDir)
    const shellCommandFile = join(dataDir, 'shell-command.txt')
    const fakeShell = join(binDir, 'fake-zsh')
    writeFileSync(
      fakeShell,
      [
        '#!/bin/sh',
        'last_arg=""',
        'for arg in "$@"; do last_arg="$arg"; done',
        `printf '%s\\n' "$last_arg" > "${shellCommandFile}"`,
        'echo worker custom shell ready',
        'sleep 60',
      ].join('\n')
    )
    chmodSync(fakeShell, 0o755)
    setEnv('SHELL', fakeShell)

    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server.baseUrl, cookie)

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart: true,
        name: 'QwenWorker',
        role: 'coder',
        startup_command: 'qwen --model qwen3-coder',
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      agent_start: { ok: boolean; error: string | null; run_id: string | null }
      id: string
    }
    expect(body.agent_start).toMatchObject({ error: null, ok: true })
    expect(typeof body.agent_start.run_id).toBe('string')
    expect(server.store.peekAgentLaunchConfig(workspace.id, body.id)).toMatchObject({
      args: ['-lic', 'qwen --model qwen3-coder'],
      command: fakeShell,
      commandPresetId: null,
      interactiveCommand: 'qwen',
      presetAugmentationDisabled: true,
      sessionIdCapture: null,
    })
    await waitFor(() => {
      expect(readFileSync(shellCommandFile, 'utf8')).toBe('qwen --model qwen3-coder\n')
    })
    await waitFor(() => {
      expect(server.store.getLiveRun(body.agent_start.run_id ?? '').output).toContain(
        'worker custom shell ready'
      )
    })

    if (body.agent_start.run_id) server.store.stopAgentRun(body.agent_start.run_id)
  })

  test('custom worker startup command reports the missing executable, not the shell', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-worker-custom-start-missing-'))
    tempDirs.push(dataDir)
    setEnv('SHELL', '/bin/sh')

    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server.baseUrl, cookie)
    const missingCommand = 'definitely-missing-hive-agent --serve'

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart: true,
        command_preset_id: 'claude',
        name: 'MissingCustomAgent',
        role: 'coder',
        startup_command: missingCommand,
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      agent_start: { ok: boolean; error: string | null; run_id: string | null }
      id: string
    }
    expect(body.agent_start).toMatchObject({
      error: 'definitely-missing-hive-agent CLI not found in PATH',
      ok: false,
    })
    expect(body.agent_start.error).not.toContain('/bin/sh')
    if (body.agent_start.run_id) server.store.stopAgentRun(body.agent_start.run_id)
  })
})
