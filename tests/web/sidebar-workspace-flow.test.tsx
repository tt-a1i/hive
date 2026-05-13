// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { App } from '../../web/src/app.js'
import { Sidebar } from '../../web/src/sidebar/Sidebar.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
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
  const startResponse = await nativeFetch(
    `${baseUrl}/api/workspaces/${workspaceId}/agents/${worker.id}/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ hive_port: baseUrl.split(':').at(-1) }),
    }
  )
  const start = (await startResponse.json()) as { runId: string }
  return start.runId
}

const openTerminalSockets = () =>
  MockWebSocket.instances.filter((socket) => socket.url.includes('/ws/terminal/') && !socket.closed)

const waitForTerminalPolling = () => new Promise((resolve) => setTimeout(resolve, 250))

const emptyProps = {
  activeWorkspaceId: null,
  onCreateClick: vi.fn(),
  onDeleteWorkspace: vi.fn(),
  onSelectWorkspace: vi.fn(),
  workersByWorkspaceId: {},
}

const fakeWorkspace: WorkspaceSummary = {
  id: 'ws-1',
  name: 'My Project',
  path: '/home/user/my-project',
}

const renderSidebar = (props: Parameters<typeof Sidebar>[0]) =>
  render(
    <ToastProvider>
      <Sidebar {...props} />
    </ToastProvider>
  )

describe('Sidebar EmptyState CTA', () => {
  afterEach(() => vi.clearAllMocks())

  test('empty workspaces shows New workspace CTA inside the EmptyState, not at the bottom', () => {
    renderSidebar({ ...emptyProps, workspaces: [] })
    const emptyState = screen.getByTestId('empty-state')
    expect(within(emptyState).getByRole('button', { name: 'New workspace' })).toBeInTheDocument()
    // Bottom dashed button is hidden when list is empty:
    const allNewBtns = screen.getAllByRole('button', { name: 'New workspace' })
    expect(allNewBtns).toHaveLength(1)
    // Callback wiring: clicking the CTA must call onCreateClick.
    fireEvent.click(within(emptyState).getByRole('button', { name: 'New workspace' }))
    expect(emptyProps.onCreateClick).toHaveBeenCalledOnce()
  })

  test('non-empty workspaces keeps the dashed bottom New workspace button', () => {
    renderSidebar({ ...emptyProps, workspaces: [fakeWorkspace] })
    const bottomBtn = screen.getByRole('button', { name: 'New workspace' })
    expect(bottomBtn).toHaveClass('ws-add')
  })
})

describe('workspace sidebar flow', () => {
  test('switching workspace does not mount detached terminal sockets', async () => {
    const alpha = await createWorkspace('Alpha')
    const beta = await createWorkspace('Beta')
    mkdirSync(alpha.path, { recursive: true })
    const alphaRunId = await configureAndStartWorker(alpha.id, alpha.path)

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-current', 'true')
    })
    expect(screen.queryByLabelText(/Terminal Alice/)).toBeNull()
    expect(openTerminalSockets()).toHaveLength(0)

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

    const staleAlphaSlot = document.createElement('div')
    staleAlphaSlot.id = `worker-pty-${alphaRunId}`
    document.body.appendChild(staleAlphaSlot)
    await waitForTerminalPolling()
    expect(screen.queryByLabelText(/Terminal Alice/)).toBeNull()
    expect(openTerminalSockets()).toHaveLength(0)
    staleAlphaSlot.remove()
  })

  test('deleting the active workspace shows Confirm, removes it, selects next', async () => {
    const alpha = await createWorkspace('Alpha')
    const beta = await createWorkspace('Beta')

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-current', 'true')
    })

    // Click trash icon → Confirm dialog opens (no native window.confirm).
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace Alpha' }))
    const confirmTitle = await screen.findByTestId('confirm-title')
    expect(confirmTitle).toHaveTextContent('Delete workspace "Alpha"?')
    expect(screen.getByTestId('confirm-action')).toHaveTextContent('Delete workspace')

    // Confirming actually performs the delete.
    fireEvent.click(screen.getByTestId('confirm-action'))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-current', 'true')
    })

    await waitFor(async () => {
      const workspaceResponse = await nativeFetch(`${baseUrl}/api/workspaces`, {
        headers: { cookie },
      })
      await expect(workspaceResponse.json()).resolves.toEqual([
        expect.objectContaining({ id: beta.id, name: 'Beta' }),
      ])
    })

    await waitFor(async () => {
      const appStateResponse = await nativeFetch(
        `${baseUrl}/api/settings/app-state/active_workspace_id`,
        { headers: { cookie } }
      )
      await expect(appStateResponse.json()).resolves.toEqual({
        key: 'active_workspace_id',
        value: beta.id,
      })
    })
    expect(alpha.id).not.toBe(beta.id)
  })
})
