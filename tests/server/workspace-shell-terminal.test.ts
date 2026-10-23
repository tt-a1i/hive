import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { TerminalStateMirror } from '../../src/server/terminal-state-mirror.js'
import { getWorkspaceShellAgentId } from '../../src/server/workspace-shell-runtime.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
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
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const setEnv = (key: string, value: string | undefined) => {
  restoreEnv.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('workspace shell terminal', () => {
  test.each([
    'delete',
    'exit',
  ] as const)('disposes a viewed shell mirror after %s without affecting a live sibling', async (mode) => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-shell-mirror-cleanup-'))
    tempDirs.push(workspacePath)
    const server = await startTestServer()
    const writes = vi.spyOn(TerminalStateMirror.prototype, 'write')
    const disposals = vi.spyOn(TerminalStateMirror.prototype, 'dispose')
    const sockets: WebSocket[] = []

    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Mirror cleanup',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const startViewedShell = async (marker: string) => {
        const response = await fetch(
          `${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`,
          { method: 'POST', headers: { cookie } }
        )
        expect(response.status).toBe(201)
        const shell = (await response.json()) as { run_id: string }
        const io = await openSocket(
          toWsUrl(server.baseUrl, `/ws/terminal/${shell.run_id}/io?clientId=${marker}`),
          cookie
        )
        sockets.push(io)
        const output: string[] = []
        io.on('message', (chunk) => output.push(chunk.toString()))
        const control = new WebSocket(
          toWsUrl(server.baseUrl, `/ws/terminal/${shell.run_id}/control?clientId=${marker}`),
          { headers: { cookie } }
        )
        sockets.push(control)
        const messages: Array<{ type: string }> = []
        control.on('message', (chunk) => messages.push(JSON.parse(chunk.toString())))
        await waitFor(() =>
          expect(messages.some((message) => message.type === 'restore')).toBe(true)
        )
        control.send(JSON.stringify({ type: 'restore_complete' }))
        io.send(`echo ${marker}\r`)
        await waitFor(() => expect(output.join('')).toContain(marker))
        const mirrorOutput = new Map<TerminalStateMirror, string>()
        writes.mock.calls.forEach(([chunk], index) => {
          const mirror = writes.mock.contexts[index]
          if (mirror) mirrorOutput.set(mirror, (mirrorOutput.get(mirror) ?? '') + chunk)
        })
        const mirror = [...mirrorOutput].find(([, output]) => output.includes(marker))?.[0]
        expect(mirror).toBeInstanceOf(TerminalStateMirror)
        return { ...shell, io, control, output, messages, mirror }
      }

      const target = await startViewedShell('TARGET_MIRROR')
      const sibling = await startViewedShell('SIBLING_MIRROR')
      expect(target.mirror).not.toBe(sibling.mirror)
      if (mode === 'delete') {
        const response = await fetch(
          `${server.baseUrl}/api/workspaces/${workspace.id}/shell/${target.run_id}`,
          { method: 'DELETE', headers: { cookie } }
        )
        expect(response.status).toBe(204)
        expect(server.store.findLiveRun(target.run_id)).toBeUndefined()
      } else {
        target.io.send('exit\r')
        await waitFor(() =>
          expect(target.messages.some((message) => message.type === 'exit')).toBe(true)
        )
      }
      target.io.close()
      target.control.close()
      await waitFor(() => {
        expect(target.io.readyState).toBe(WebSocket.CLOSED)
        expect(target.control.readyState).toBe(WebSocket.CLOSED)
        expect(disposals.mock.contexts.filter((mirror) => mirror === target.mirror)).toHaveLength(1)
      })
      expect(disposals.mock.contexts).not.toContain(sibling.mirror)
      expect(server.store.getLiveRun(sibling.run_id).status).toBe('running')
      sibling.io.send('echo SIBLING_STILL_RUNNING\r')
      await waitFor(() => expect(sibling.output.join('')).toContain('SIBLING_STILL_RUNNING'))
    } finally {
      for (const socket of sockets) socket.close()
      try {
        await server.close()
      } finally {
        writes.mockRestore()
        disposals.mockRestore()
      }
    }
  }, 30000)

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
      const secondShell = shells[1]
      if (!secondShell) throw new Error('Expected the second shell start response')
      const closedShellRunId = secondShell.run_id

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
    const sendExitAfterStart = process.platform === 'win32'
    if (process.platform === 'win32') {
      // Real Windows shells are launched through ComSpec=cmd.exe. Keep that
      // shape and ask the shell to exit after it starts, so this still covers
      // the PTY onExit cleanup path without pretending a .cmd file is cmd.exe.
    } else {
      writeFileSync(fakeShell, ['#!/bin/sh', 'echo shell exiting', 'exit 0'].join('\n'))
      chmodSync(fakeShell, 0o755)
      setEnv('SHELL', fakeShell)
    }
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
      if (sendExitAfterStart) server.store.writeRunInput(shell.run_id, 'exit\r')

      await waitFor(async () => {
        const runsResponse = await fetch(
          `${server.baseUrl}/api/ui/workspaces/${workspace.id}/runs`,
          { headers: { cookie } }
        )
        expect(runsResponse.status).toBe(200)
        const runs = (await runsResponse.json()) as Array<{ run_id: string }>
        expect(runs).not.toContainEqual(expect.objectContaining({ run_id: shell.run_id }))
      }, 8000)
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
