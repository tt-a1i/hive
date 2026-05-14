import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<{ close: () => Promise<void> }> = []
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

const makeWorkspacePath = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `hive-autostart-${label}-`))
  tempDirs.push(dir)
  return dir
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

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

const startServer = async (input: { dataDir?: string } = {}) => {
  const store = createRuntimeStore({
    agentManager: createAgentManager(),
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
  })
  const app = createApp({ store })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push({
    async close() {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    },
  })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('No port')

  return { store, baseUrl: `http://127.0.0.1:${address.port}` }
}

beforeEach(() => {
  // Default for these tests: drive the dummy CLI so the happy path doesn't
  // depend on `claude` being on PATH.
  setEnv('HIVE_ORCHESTRATOR_COMMAND', 'bash')
  setEnv('HIVE_ORCHESTRATOR_ARGS_JSON', JSON.stringify(['-c', 'echo queen up; sleep 60']))
})

describe('POST /api/workspaces autostart_orchestrator', () => {
  test('rejects missing workspace paths before creating a workspace', async () => {
    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)
    const missingPath = join(tmpdir(), `hive-missing-${Date.now()}`)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: missingPath, name: 'Missing' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: `Workspace path does not exist: ${missingPath}`,
    })
    expect(store.listWorkspaces()).toEqual([])
  })

  test('autostart happy path returns ok=true + run_id, PTY visible in terminal runs', async () => {
    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: makeWorkspacePath('happy'), name: 'AutoHappy' }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toMatchObject({ error: null, ok: true })
    expect(body.orchestrator_start.error).toBeNull()
    expect(typeof body.orchestrator_start.run_id).toBe('string')

    // The orchestrator PTY should be available via listTerminalRuns (this is what
    // the UI polls to find `orch-pty-{runId}` slot).
    const runs = store.listTerminalRuns(body.id)
    const orchestratorRun = runs.find((run) => run.agent_id === `${body.id}:orchestrator`)
    expect(orchestratorRun).toBeDefined()
    expect(orchestratorRun?.run_id).toBe(body.orchestrator_start.run_id)

    // Stop to release the PTY before teardown.
    if (orchestratorRun) store.stopAgentRun(orchestratorRun.run_id)
  })

  test('manual start during workspace autostart reuses the active orchestrator run', async () => {
    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: makeWorkspacePath('dedupe'), name: 'Dedupe' }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toMatchObject({ error: null, ok: true })
    expect(typeof body.orchestrator_start.run_id).toBe('string')

    const startResponse = await fetch(
      `${baseUrl}/api/workspaces/${body.id}/agents/${body.id}:orchestrator/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ hive_port: baseUrl.split(':').at(-1) }),
      }
    )
    expect(startResponse.status).toBe(201)
    const startBody = (await startResponse.json()) as { run_id: string }
    expect(startBody.run_id).toBe(body.orchestrator_start.run_id)

    const orchestratorRuns = store
      .listTerminalRuns(body.id)
      .filter((run) => run.agent_id === `${body.id}:orchestrator`)
    expect(orchestratorRuns).toHaveLength(1)

    store.stopAgentRun(startBody.run_id)
  })

  test('concurrent HTTP starts for one orchestrator share a single PTY run', async () => {
    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)
    const workspacePath = makeWorkspacePath('http-dedupe')
    const pidsFile = join(workspacePath, 'pids.txt')
    const scriptPath = join(workspacePath, 'http-dedupe-agent.js')
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n')`,
        "console.log('http-dedupe-started')",
        'setInterval(() => {}, 1000)',
      ].join('\n')
    )
    setEnv('HIVE_ORCHESTRATOR_COMMAND', process.execPath)
    setEnv('HIVE_ORCHESTRATOR_ARGS_JSON', JSON.stringify([scriptPath]))

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        path: workspacePath,
        name: 'HttpDedupe',
        autostart_orchestrator: false,
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toEqual({ ok: false, error: null, run_id: null })

    const startResponses = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`${baseUrl}/api/workspaces/${body.id}/agents/${body.id}:orchestrator/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ hive_port: baseUrl.split(':').at(-1) }),
        })
      )
    )
    expect(startResponses.every((item) => item.status === 201)).toBe(true)
    const startBodies = (await Promise.all(startResponses.map((item) => item.json()))) as Array<{
      run_id: string
    }>
    const runIds = new Set(startBodies.map((item) => item.run_id))
    expect(runIds.size).toBe(1)
    let spawnedPid: number | undefined
    await waitFor(() => {
      expect(existsSync(pidsFile)).toBe(true)
      const pids = readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean)
      expect(new Set(pids).size).toBe(1)
      expect(pids).toHaveLength(1)
      spawnedPid = Number(pids[0])
      expect(isProcessAlive(spawnedPid)).toBe(true)
    })

    const orchestratorRuns = store
      .listTerminalRuns(body.id)
      .filter((run) => run.agent_id === `${body.id}:orchestrator`)
    expect(orchestratorRuns).toHaveLength(1)

    store.stopAgentRun(startBodies[0].run_id)
    await waitFor(() => {
      if (!spawnedPid) throw new Error('Expected spawned pid')
      expect(isProcessAlive(spawnedPid)).toBe(false)
    })
  })

  test('autostart_orchestrator: false skips spawn, no run started', async () => {
    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        path: makeWorkspacePath('skip'),
        name: 'SkipMe',
        autostart_orchestrator: false,
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toEqual({ ok: false, error: null, run_id: null })
    expect(store.listTerminalRuns(body.id)).toEqual([])
  })

  test('default Claude orchestrator launch injects bypass permission args', async () => {
    setEnv('HIVE_ORCHESTRATOR_COMMAND', undefined)
    setEnv('HIVE_ORCHESTRATOR_ARGS_JSON', undefined)

    const agentManager = createAgentManager()
    const startSpy = vi.spyOn(agentManager, 'startAgent').mockImplementation(async (input) => ({
      agentId: input.agentId,
      exitCode: null,
      output: '',
      pid: 123,
      runId: 'run-default-claude',
      status: 'running',
    }))
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-default-claude-'))
    tempDirs.push(dataDir)
    const store = createRuntimeStore({ agentManager, dataDir })
    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push({
      async close() {
        await new Promise<void>((resolve) => app.server.close(() => resolve()))
      },
    })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: makeWorkspacePath('default-claude'), name: 'DefaultClaude' }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toMatchObject({ error: null, ok: true })
    expect(startSpy).toHaveBeenCalledOnce()
    const startInput = startSpy.mock.calls[0]?.[0]
    expect(startInput?.command).toBe('claude')
    expect(startInput?.args).toEqual([
      '--dangerously-skip-permissions',
      '--permission-mode=bypassPermissions',
      '--disallowedTools=Task',
    ])
    expect(
      store.peekAgentLaunchConfig(body.id, `${body.id}:orchestrator`)?.commandPresetId
    ).toBeNull()
  })

  test('UI workspace autostart uses the runtime socket port instead of client hive_port', async () => {
    const portDir = makeWorkspacePath('runtime-port-file')
    const portFile = join(portDir, 'port.txt')
    setEnv('HIVE_ORCHESTRATOR_COMMAND', process.execPath)
    setEnv(
      'HIVE_ORCHESTRATOR_ARGS_JSON',
      JSON.stringify([
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(
          portFile
        )}, process.env.HIVE_PORT || ''); setInterval(() => {}, 1000)`,
      ])
    )

    const { store, baseUrl } = await startServer()
    const port = baseUrl.split(':').at(-1)
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        hive_port: '65535',
        name: 'RuntimePort',
        path: makeWorkspacePath('runtime-port'),
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      orchestrator_start: { run_id: string | null }
    }
    await waitFor(() => {
      expect(existsSync(portFile)).toBe(true)
      expect(readFileSync(portFile, 'utf8')).toBe(port)
    })
    if (body.orchestrator_start.run_id) store.stopAgentRun(body.orchestrator_start.run_id)
  })

  test('command_preset_id selects the orchestrator CLI preset for autostart', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'hive-codex-bin-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-preset-codex-'))
    tempDirs.push(binDir)
    tempDirs.push(dataDir)
    const fakeCodex = join(binDir, 'codex')
    writeFileSync(fakeCodex, ['#!/bin/sh', 'echo codex orchestrator up', 'sleep 60'].join('\n'))
    chmodSync(fakeCodex, 0o755)
    setEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
    const codexHome = mkdtempSync(join(tmpdir(), 'hive-codex-home-'))
    tempDirs.push(codexHome)
    setEnv('CODEX_HOME', codexHome)

    const { store, baseUrl } = await startServer({ dataDir })
    const cookie = await getUiCookie(baseUrl)
    const workspacePath = makeWorkspacePath('preset-codex')
    mkdirSync(workspacePath, { recursive: true })

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        command_preset_id: 'codex',
        name: 'PresetCodex',
        path: workspacePath,
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toMatchObject({ error: null, ok: true })
    const config = store.peekAgentLaunchConfig(body.id, `${body.id}:orchestrator`)
    expect(config?.command).toBe('codex')
    expect(config?.commandPresetId).toBe('codex')

    const run = store
      .listTerminalRuns(body.id)
      .find((item) => item.agent_id === `${body.id}:orchestrator`)
    if (run) store.stopAgentRun(run.run_id)
  })

  test('OpenCode orchestrator preset autostarts without Claude yolo args', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'hive-opencode-bin-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-preset-opencode-'))
    tempDirs.push(binDir)
    tempDirs.push(dataDir)
    const argsFile = join(dataDir, 'opencode-args.txt')
    const fakeOpenCode = join(binDir, 'opencode')
    writeFileSync(
      fakeOpenCode,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${argsFile}"`,
        'echo opencode orchestrator up',
        'sleep 60',
      ].join('\n')
    )
    chmodSync(fakeOpenCode, 0o755)
    setEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
    const opencodeHome = mkdtempSync(join(tmpdir(), 'hive-opencode-home-'))
    tempDirs.push(opencodeHome)
    setEnv('HIVE_OPENCODE_DB_PATH', join(opencodeHome, 'opencode.db'))

    const { store, baseUrl } = await startServer({ dataDir })
    const cookie = await getUiCookie(baseUrl)
    const workspacePath = makeWorkspacePath('preset-opencode')
    mkdirSync(workspacePath, { recursive: true })

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        command_preset_id: 'opencode',
        name: 'PresetOpenCode',
        path: workspacePath,
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toMatchObject({ error: null, ok: true })
    const config = store.peekAgentLaunchConfig(body.id, `${body.id}:orchestrator`)
    expect(config?.command).toBe('opencode')
    expect(config?.commandPresetId).toBe('opencode')

    await waitFor(() => {
      expect(readFileSync(argsFile, 'utf8')).toBe('\n')
    })
    expect(readFileSync(argsFile, 'utf8')).not.toContain('--dangerously-skip-permissions')
    expect(readFileSync(argsFile, 'utf8')).not.toContain('bypass')

    if (body.orchestrator_start.run_id) store.stopAgentRun(body.orchestrator_start.run_id)
  })

  test('startup_command runs through the user shell so aliases can expand', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'hive-custom-start-bin-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-custom-start-'))
    tempDirs.push(binDir)
    tempDirs.push(dataDir)
    const shellArgsFile = join(dataDir, 'shell-args.txt')
    const shellCommandFile = join(dataDir, 'shell-command.txt')
    const fakeShell = join(binDir, 'fake-zsh')
    writeFileSync(
      fakeShell,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${shellArgsFile}"`,
        `printf '%s\\n' "$2" > "${shellCommandFile}"`,
        'sleep 60',
      ].join('\n')
    )
    chmodSync(fakeShell, 0o755)
    setEnv('SHELL', fakeShell)
    setEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)

    const { store, baseUrl } = await startServer({ dataDir })
    const cookie = await getUiCookie(baseUrl)
    const workspacePath = makeWorkspacePath('custom-start')
    mkdirSync(workspacePath, { recursive: true })

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        command_preset_id: 'claude',
        name: 'CustomStart',
        path: workspacePath,
        startup_command: 'ccs --resume f500de1d-df89-470f-a2ce-e385acffef19 --label "old session"',
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toMatchObject({ error: null, ok: true })

    const config = store.peekAgentLaunchConfig(body.id, `${body.id}:orchestrator`)
    expect(config).toMatchObject({
      args: ['-lic', 'ccs --resume f500de1d-df89-470f-a2ce-e385acffef19 --label "old session"'],
      command: fakeShell,
      commandPresetId: null,
      interactiveCommand: 'claude',
      presetAugmentationDisabled: true,
      sessionIdCapture: expect.objectContaining({ source: 'claude_project_jsonl_dir' }),
    })
    await waitFor(() => {
      expect(readFileSync(shellCommandFile, 'utf8')).toBe(
        'ccs --resume f500de1d-df89-470f-a2ce-e385acffef19 --label "old session"\n'
      )
    })
    expect(readFileSync(shellArgsFile, 'utf8')).not.toContain('bypass')

    if (body.orchestrator_start.run_id) store.stopAgentRun(body.orchestrator_start.run_id)
  })

  test('startup_command is saved when workspace creation skips autostart', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'hive-custom-start-manual-bin-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-custom-start-manual-'))
    tempDirs.push(binDir)
    tempDirs.push(dataDir)
    const shellCommandFile = join(dataDir, 'manual-shell-command.txt')
    const fakeShell = join(binDir, 'fake-zsh')
    writeFileSync(
      fakeShell,
      ['#!/bin/sh', `printf '%s\\n' "$2" > "${shellCommandFile}"`, 'sleep 60'].join('\n')
    )
    chmodSync(fakeShell, 0o755)
    setEnv('SHELL', fakeShell)
    setEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)

    const { store, baseUrl } = await startServer({ dataDir })
    const cookie = await getUiCookie(baseUrl)
    const workspacePath = makeWorkspacePath('custom-start-manual')
    mkdirSync(workspacePath, { recursive: true })

    const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart_orchestrator: false,
        name: 'ManualCustomStart',
        path: workspacePath,
        startup_command: 'claude --resume f500de1d-df89-470f-a2ce-e385acffef19',
      }),
    })

    expect(createResponse.status).toBe(201)
    const workspace = (await createResponse.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(workspace.orchestrator_start).toEqual({ error: null, ok: false, run_id: null })
    const orchestratorId = `${workspace.id}:orchestrator`
    expect(store.peekAgentLaunchConfig(workspace.id, orchestratorId)).toMatchObject({
      args: ['-lic', 'claude --resume f500de1d-df89-470f-a2ce-e385acffef19'],
      command: fakeShell,
      commandPresetId: null,
      interactiveCommand: 'claude',
      presetAugmentationDisabled: true,
      sessionIdCapture: expect.objectContaining({ source: 'claude_project_jsonl_dir' }),
    })

    const startResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ hive_port: baseUrl.split(':').at(-1) }),
      }
    )
    expect(startResponse.status).toBe(201)
    const startBody = (await startResponse.json()) as { run_id: string }
    await waitFor(() => {
      expect(readFileSync(shellCommandFile, 'utf8')).toBe(
        'claude --resume f500de1d-df89-470f-a2ce-e385acffef19\n'
      )
    })
    store.stopAgentRun(startBody.run_id)
  })

  test('spawn failure (async exit) does NOT block workspace creation, surfaces binary name', async () => {
    setEnv('HIVE_ORCHESTRATOR_COMMAND', '/definitely/not/a/real/binary')
    setEnv('HIVE_ORCHESTRATOR_ARGS_JSON', '[]')

    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: makeWorkspacePath('fail'), name: 'FailFast' }),
    })

    // Workspace creation must succeed even though spawn fails — that's the red line.
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start.ok).toBe(false)
    // Error must contain the binary so the UI can show meaningful context.
    expect(body.orchestrator_start.error ?? '').toContain('/definitely/not/a/real/binary')

    // Workspace itself was persisted and listable.
    const workspaces = store.listWorkspaces()
    expect(workspaces.some((workspace) => workspace.id === body.id)).toBe(true)
  })

  test('async exit 127 (child dies after spawn succeeds) returns "<cmd> CLI not found in PATH"', async () => {
    // Real PTY path: node-pty spawns successfully, then the child shell dies
    // with exit code 127 because the inner command is missing. This is the
    // common production case (e.g. `claude` is on PATH but the wrapper script
    // shells out to a missing helper) and the autostart wrapper MUST translate
    // it to the same UX string as the sync ENOENT branch.
    //
    // We use `bash -c 'exit 127'` so the test does not depend on any specific
    // missing binary. `config.command` is therefore `bash`, which yields
    // `bash CLI not found in PATH` — slightly odd-looking but exactly the
    // mechanic we want to lock in. Real users configure `claude` and see
    // `claude CLI not found in PATH`, which reads correctly.
    setEnv('HIVE_ORCHESTRATOR_COMMAND', 'bash')
    setEnv('HIVE_ORCHESTRATOR_ARGS_JSON', JSON.stringify(['-c', 'exit 127']))

    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: makeWorkspacePath('async-127'), name: 'Async127' }),
    })

    // Spawn-failure-not-blocking red line: workspace creation must still 201.
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start.ok).toBe(false)
    // Exact-equality assertion so the translation cannot regress to a generic
    // message like `bash failed to start (exit 127)`.
    expect(body.orchestrator_start.error).toBe('bash CLI not found in PATH')
    // run_id IS returned for async-exit (the run was started before it died),
    // unlike the sync-throw path where no run id exists.
    expect(typeof body.orchestrator_start.run_id).toBe('string')

    // Workspace itself was persisted.
    expect(store.listWorkspaces().some((workspace) => workspace.id === body.id)).toBe(true)
  })

  test('spawn ENOENT (synchronous throw) returns "<cmd> CLI not found in PATH"', async () => {
    setEnv('HIVE_ORCHESTRATOR_COMMAND', 'claude')
    setEnv('HIVE_ORCHESTRATOR_ARGS_JSON', '[]')

    const agentManager = createAgentManager()
    // Simulate the kernel-throwing-ENOENT branch (which node-pty *does* surface
    // synchronously on some platforms / for permission-denied paths). The
    // wrapper must format this as `claude CLI not found in PATH`.
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    vi.spyOn(agentManager, 'startAgent').mockImplementation(async () => {
      throw enoent
    })

    const store = createRuntimeStore({ agentManager })
    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push({
      async close() {
        await store.close()
        await new Promise<void>((resolve) => app.server.close(() => resolve()))
      },
    })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: makeWorkspacePath('enoent'), name: 'NoBinary' }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toEqual({
      ok: false,
      error: 'claude CLI not found in PATH',
      run_id: null,
    })
  })

  test('real missing command from PATH returns "<cmd> CLI not found in PATH"', async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'hive-empty-path-'))
    tempDirs.push(emptyPath)
    setEnv('HIVE_ORCHESTRATOR_COMMAND', 'claude')
    setEnv('HIVE_ORCHESTRATOR_ARGS_JSON', '[]')
    setEnv('PATH', emptyPath)

    const { store, baseUrl } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: makeWorkspacePath('missing-path'), name: 'MissingPath' }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      id: string
      orchestrator_start: { ok: boolean; error: string | null; run_id: string | null }
    }
    expect(body.orchestrator_start).toEqual({
      ok: false,
      error: 'claude CLI not found in PATH',
      run_id: null,
    })
    expect(store.listWorkspaces().some((workspace) => workspace.id === body.id)).toBe(true)
  })

  test('manual orchestrator start seeds missing launch config and uses runtime socket port', async () => {
    const portDir = makeWorkspacePath('manual-start-port-file')
    const portFile = join(portDir, 'port.txt')
    setEnv('HIVE_ORCHESTRATOR_COMMAND', process.execPath)
    setEnv(
      'HIVE_ORCHESTRATOR_ARGS_JSON',
      JSON.stringify([
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(
          portFile
        )}, process.env.HIVE_PORT || ''); setInterval(() => {}, 1000)`,
      ])
    )

    const { store, baseUrl } = await startServer()
    const port = baseUrl.split(':').at(-1)
    const cookie = await getUiCookie(baseUrl)
    const workspace = store.createWorkspace(makeWorkspacePath('manual-seed'), 'ManualSeed')
    const orchestratorId = `${workspace.id}:orchestrator`
    expect(store.peekAgentLaunchConfig(workspace.id, orchestratorId)).toBeUndefined()

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ hive_port: '65535' }),
      }
    )

    expect(response.status).toBe(201)
    const body = (await response.json()) as { run_id: string }
    expect(typeof body.run_id).toBe('string')
    expect(store.peekAgentLaunchConfig(workspace.id, orchestratorId)?.command).toBe(
      process.execPath
    )
    await waitFor(() => {
      expect(existsSync(portFile)).toBe(true)
      expect(readFileSync(portFile, 'utf8')).toBe(port)
    })
    store.stopAgentRun(body.run_id)
  })
})
