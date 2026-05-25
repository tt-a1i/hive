import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import { getWorkspaceShellAgentId } from '../../src/server/workspace-shell-runtime.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const restoreEnv: Array<[string, string | undefined]> = []

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

const toWsUrl = (baseUrl: string, suffix: string) => baseUrl.replace('http://', 'ws://') + suffix

const openSocket = async (url: string, cookie: string) =>
  await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })

afterEach(() => {
  while (restoreEnv.length > 0) {
    const [key, value] = restoreEnv.pop() ?? ['', undefined]
    if (!key) continue
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const setEnv = (key: string, value: string | undefined) => {
  restoreEnv.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('workspace shell terminal', () => {
  test('uses an unnumbered shell label after starting and replacing shells', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-shell-terminal-gap-'))
    tempDirs.push(workspacePath)
    const server = await startTestServer()

    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Shell Gap',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }

      const shells: Array<{ agent_name: string; run_id: string }> = []
      for (let index = 0; index < 3; index += 1) {
        const startResponse = await fetch(
          `${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`,
          { method: 'POST', headers: { cookie } }
        )
        expect(startResponse.status).toBe(201)
        shells.push((await startResponse.json()) as { agent_name: string; run_id: string })
      }

      expect(shells.map((shell) => shell.agent_name)).toEqual(['Shell', 'Shell', 'Shell'])
      const closedShellRunId = shells[1]!.run_id

      const closeResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/shell/${closedShellRunId}`,
        { method: 'DELETE', headers: { cookie } }
      )
      expect(closeResponse.status).toBe(204)

      const replacementResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(replacementResponse.status).toBe(201)
      const replacementShell = (await replacementResponse.json()) as {
        agent_name: string
        run_id: string
      }

      expect(replacementShell.agent_name).toBe('Shell')
      expect(replacementShell.run_id).not.toBe(closedShellRunId)
    } finally {
      await server.close()
    }
  }, 60000)

  test('removes a workspace shell run when the shell exits on its own', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-shell-terminal-exit-'))
    const binDir = mkdtempSync(join(tmpdir(), 'hive-shell-terminal-exit-bin-'))
    tempDirs.push(workspacePath)
    tempDirs.push(binDir)
    const fakeShell = join(binDir, 'fake-shell')
    writeFileSync(fakeShell, ['#!/bin/sh', 'echo shell exiting', 'exit 0'].join('\n'))
    chmodSync(fakeShell, 0o755)
    setEnv('SHELL', fakeShell)
    const server = await startTestServer()

    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Shell Exit',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }

      const startResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(startResponse.status).toBe(201)
      const shell = (await startResponse.json()) as { agent_name: string; run_id: string }
      expect(shell.agent_name).toBe('Shell')

      await waitFor(async () => {
        const runsResponse = await fetch(
          `${server.baseUrl}/api/ui/workspaces/${workspace.id}/runs`,
          { headers: { cookie } }
        )
        expect(runsResponse.status).toBe(200)
        const runs = (await runsResponse.json()) as Array<{ run_id: string }>
        expect(runs).not.toContainEqual(expect.objectContaining({ run_id: shell.run_id }))
      })
    } finally {
      await server.close()
    }
  }, 60000)

  test('starts one workspace shell and wires it through the terminal websocket', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-shell-terminal-'))
    tempDirs.push(workspacePath)
    const server = await startTestServer()

    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Shell',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }

      const startResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(startResponse.status).toBe(201)
      const shell = (await startResponse.json()) as {
        agent_id: string
        agent_name: string
        run_id: string
        status: string
      }
      expect(shell).toMatchObject({
        agent_id: getWorkspaceShellAgentId(workspace.id),
        agent_name: 'Shell',
        run_id: expect.any(String),
      })

      const secondStart = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(secondStart.status).toBe(201)
      const secondShell = (await secondStart.json()) as {
        agent_id: string
        agent_name: string
        run_id: string
        status: string
      }
      expect(secondShell.run_id).not.toBe(shell.run_id)
      expect(secondShell.agent_name).toBe('Shell')

      const runsResponse = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/runs`, {
        headers: { cookie },
      })
      expect(runsResponse.status).toBe(200)
      const runs = (await runsResponse.json()) as Array<{ agent_name: string; run_id: string }>
      expect(runs).toContainEqual(expect.objectContaining({ run_id: shell.run_id }))
      expect(runs).toContainEqual(expect.objectContaining({ run_id: secondShell.run_id }))
      expect(runs.map((run) => run.agent_name)).toEqual(expect.arrayContaining(['Shell', 'Shell']))

      const closeResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/shell/${shell.run_id}`,
        { method: 'DELETE', headers: { cookie } }
      )
      expect(closeResponse.status).toBe(204)

      const afterCloseResponse = await fetch(
        `${server.baseUrl}/api/ui/workspaces/${workspace.id}/runs`,
        { headers: { cookie } }
      )
      expect(afterCloseResponse.status).toBe(200)
      const afterCloseRuns = (await afterCloseResponse.json()) as Array<{ run_id: string }>
      expect(afterCloseRuns).not.toContainEqual(expect.objectContaining({ run_id: shell.run_id }))
      expect(afterCloseRuns).toContainEqual(expect.objectContaining({ run_id: secondShell.run_id }))

      const recycledStart = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`,
        { method: 'POST', headers: { cookie } }
      )
      expect(recycledStart.status).toBe(201)
      const recycledShell = (await recycledStart.json()) as {
        agent_id: string
        agent_name: string
        run_id: string
        status: string
      }
      expect(recycledShell.run_id).not.toBe(shell.run_id)
      expect(recycledShell.run_id).not.toBe(secondShell.run_id)
      expect(recycledShell.agent_name).toBe('Shell')

      const io = await openSocket(
        toWsUrl(server.baseUrl, `/ws/terminal/${secondShell.run_id}/io`),
        cookie
      )
      const received: string[] = []
      io.on('message', (chunk) => received.push(chunk.toString()))
      io.send(process.platform === 'win32' ? 'cd\r' : 'pwd\r')

      await waitFor(() => {
        const output = received.join('').toLowerCase()
        expect(output).toContain(basename(workspacePath).toLowerCase())
      })

      io.close()
    } finally {
      await server.close()
    }
  }, 60000)
})
