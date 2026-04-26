// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

class MockTerminal {
  loadAddon() {}
  onData() {
    return { dispose() {} }
  }
  open() {}
  write(_chunk?: string, callback?: () => void) {
    callback?.()
  }
  dispose() {}
}

class MockFitAddon {
  fit() {}
  dispose() {}
}

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }))

class MockWebSocket {
  static instances: MockWebSocket[] = []
  readonly OPEN = 1
  closed = false
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  readyState = 1

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }

  close() {
    this.closed = true
  }
  send() {}
}

const tempDirs: string[] = []
let cleanupServer: (() => Promise<void>) | undefined
const nativeFetch = globalThis.fetch
let baseUrl = ''
let cookie = ''

beforeEach(async () => {
  const server = await startTestServer()
  cleanupServer = server.close
  baseUrl = server.baseUrl
  await nativeFetch(`${baseUrl}/api/ui/session`).then((response) => {
    cookie = response.headers.get('set-cookie') ?? ''
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${baseUrl}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return nativeFetch(url, { ...init, headers })
  })
  vi.stubGlobal('WebSocket', MockWebSocket as never)
})

afterEach(async () => {
  cleanup()
  MockWebSocket.instances = []
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const createWorkspace = async (name: string) => {
  const workspacePath = mkdtempSync(join(tmpdir(), `hive-sidebar-${name}-`))
  tempDirs.push(workspacePath)
  const response = await nativeFetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name, path: workspacePath, autostart_orchestrator: false }),
  })
  return (await response.json()) as { id: string; path: string }
}

const configureAndStartWorker = async (workspaceId: string, workspacePath: string) => {
  const scriptPath = join(workspacePath, 'worker.js')
  writeFileSync(scriptPath, 'process.stdin.resume();\n')
  const workerResponse = await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  const worker = (await workerResponse.json()) as { id: string }
  await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${worker.id}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ command: process.execPath, args: [scriptPath] }),
  })
  await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${worker.id}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ hive_port: baseUrl.split(':').at(-1) }),
  })
}

describe('workspace sidebar flow', () => {
  test('switching workspace does not mount detached terminal sockets', async () => {
    const alpha = await createWorkspace('Alpha')
    const beta = await createWorkspace('Beta')
    mkdirSync(alpha.path, { recursive: true })
    await configureAndStartWorker(alpha.id, alpha.path)

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-current', 'true')
    })
    expect(screen.queryByLabelText(/Terminal Alice/)).toBeNull()
    const terminalSocketCount = MockWebSocket.instances.filter((socket) =>
      socket.url.includes('/ws/terminal/')
    ).length
    expect(terminalSocketCount).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-current', 'true')
    })
    await waitFor(async () => {
      const appStateResponse = await nativeFetch(
        `${baseUrl}/api/settings/app-state/active_workspace_id`,
        {
          headers: { cookie },
        }
      )
      await expect(appStateResponse.json()).resolves.toEqual({
        key: 'active_workspace_id',
        value: beta.id,
      })
    })
    expect(screen.queryByTestId(/^terminal-/)).toBeNull()
    const terminalSockets = MockWebSocket.instances.filter((socket) =>
      socket.url.includes('/ws/terminal/')
    )
    expect(terminalSockets).toHaveLength(0)
  })
})
