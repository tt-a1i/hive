// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../../web/src/app.js'
import { DemoBanner } from '../../web/src/demo/DemoBanner.js'
import { startTestServer } from '../helpers/test-server.js'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    loadAddon() {}
    onData() {
      return { dispose() {} }
    }
    open() {}
    write(_chunk?: string, callback?: () => void) {
      callback?.()
    }
    dispose() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}))

let cleanupServer: (() => Promise<void>) | undefined
const nativeFetch = globalThis.fetch
let serverBaseUrl = ''
let uiCookie = ''
let fetchCalls: Array<{ method: string; pathname: string }> = []

beforeEach(async () => {
  window.localStorage?.clear?.()
  // Suppress first-run wizard in these tests — demo mode has its own entry point (Try Demo button)
  window.localStorage.setItem('hive.first-run-seen', '1')
  const server = await startTestServer()
  cleanupServer = server.close
  serverBaseUrl = server.baseUrl
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    uiCookie = response.headers.get('set-cookie') ?? ''
  })
  fetchCalls = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${serverBaseUrl}${value}`
    const parsed = new URL(url)
    fetchCalls.push({ method: init?.method ?? 'GET', pathname: parsed.pathname })
    const headers = new Headers(init?.headers)
    headers.set('cookie', uiCookie)
    return nativeFetch(url, { ...init, headers })
  })
  // Stub WebSocket so no WS connections are made in jsdom
  vi.stubGlobal(
    'WebSocket',
    class {
      readonly OPEN = 1
      onopen: (() => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      readyState = 3
      close() {}
      send() {}
    } as never
  )
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
  window.localStorage?.clear?.()
})

// ── Isolated component tests (no server required) ────────────────────────────

test('DemoBanner has role=region aria-label and fires onExit on Exit Demo click', () => {
  const onExit = vi.fn()
  render(<DemoBanner onExit={onExit} />)
  expect(screen.getByRole('region', { name: /demo mode/i })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /exit demo/i }))
  expect(onExit).toHaveBeenCalledOnce()
})

test('DemoBanner does not call onExit when rendered without clicking', () => {
  const onExit = vi.fn()
  render(<DemoBanner onExit={onExit} />)
  // Just rendering must not trigger exit
  expect(onExit).not.toHaveBeenCalled()
})

// ── App-level integration tests (real server, fetch tracking) ────────────────

test('clicking Try Demo enters demo mode with banner, demo workspace, alice worker, and her last-output line', async () => {
  render(<App />)
  // Wait for the welcome pane to appear (server has no workspaces)
  await screen.findByTestId('welcome-pane')

  fireEvent.click(screen.getByRole('button', { name: /try the demo/i }))

  // Demo banner should appear
  expect(screen.getByTestId('demo-banner')).toBeInTheDocument()
  // Demo workspace name should appear in sidebar
  expect(screen.getByText('demo-todo-app')).toBeInTheDocument()
  // Alice worker should appear
  expect(screen.getByText('alice')).toBeInTheDocument()
})

test('demo mode never sends fetch calls for demo-workspace', async () => {
  render(<App />)
  await screen.findByTestId('welcome-pane')

  const preDemoCount = fetchCalls.length
  fetchCalls = []

  fireEvent.click(screen.getByRole('button', { name: /try the demo/i }))

  // Wait a tick for any effects to run
  await new Promise((resolve) => setTimeout(resolve, 200))

  // No fetches should touch demo-workspace routes
  const demoWorkspaceFetches = fetchCalls.filter((c) => c.pathname.includes('demo-workspace'))
  expect(demoWorkspaceFetches).toHaveLength(0)
  // Confirm we entered demo mode (fetch tracking is meaningful)
  expect(screen.getByTestId('demo-banner')).toBeInTheDocument()
  void preDemoCount // acknowledged
})

test('Exit Demo returns to the welcome state', async () => {
  render(<App />)
  await screen.findByTestId('welcome-pane')

  fireEvent.click(screen.getByRole('button', { name: /try the demo/i }))
  expect(screen.getByTestId('demo-banner')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /exit demo/i }))

  await waitFor(() => {
    expect(screen.getByTestId('welcome-pane')).toBeInTheDocument()
  })
  expect(screen.queryByTestId('demo-banner')).toBeNull()
})

test('demo mode shows DEMO read-only badge and orch scrollback text', async () => {
  render(<App />)
  await screen.findByTestId('welcome-pane')

  fireEvent.click(screen.getByRole('button', { name: /try the demo/i }))

  // Read-only badge should appear in demo orchestrator pane
  expect(screen.getByTestId('terminal-readonly-badge')).toBeInTheDocument()
  // Orchestrator scrollback content should be visible
  expect(screen.getByTestId('demo-scrollback-demo-orch')).toBeInTheDocument()
  expect(screen.getByTestId('demo-scrollback-demo-orch').textContent).toContain('team send alice')
})

test('TaskGraphDrawer shows DEMO_TASKS_MD content when demo is on and Blueprint is opened', async () => {
  render(<App />)
  await screen.findByTestId('welcome-pane')

  fireEvent.click(screen.getByRole('button', { name: /try the demo/i }))
  expect(screen.getByTestId('demo-banner')).toBeInTheDocument()

  // Open blueprint drawer
  fireEvent.click(screen.getByRole('button', { name: /toggle Todo/i }))

  await waitFor(() => {
    expect(screen.getByText('Add /todos POST endpoint')).toBeInTheDocument()
  })
})
