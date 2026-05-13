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
    const body = (await response.json()) as { runId: string }
    expect(typeof body.runId).toBe('string')
    expect(store.peekAgentLaunchConfig(workspace.id, orchestratorId)?.command).toBe(
      process.execPath
    )
    await waitFor(() => {
      expect(existsSync(portFile)).toBe(true)
      expect(readFileSync(portFile, 'utf8')).toBe(port)
    })
    store.stopAgentRun(body.runId)
  })
})
