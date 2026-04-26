import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const tempDirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
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
})
