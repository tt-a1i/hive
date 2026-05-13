// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
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
  vi.stubGlobal('WebSocket', class {
    readonly OPEN = 1
    onopen: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    readyState = 3
    constructor() {}
    close() {}
    send() {}
  } as never)
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
  window.localStorage?.clear?.()
})

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
  // Alice's last output line should be visible
  expect(screen.getByText('Editing src/routes/todos.ts (line 42)')).toBeInTheDocument()
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

test('TaskGraphDrawer shows DEMO_TASKS_MD content when demo is on and Blueprint is opened', async () => {
  render(<App />)
  await screen.findByTestId('welcome-pane')

  fireEvent.click(screen.getByRole('button', { name: /try the demo/i }))
  expect(screen.getByTestId('demo-banner')).toBeInTheDocument()

  // Open blueprint drawer
  fireEvent.click(screen.getByRole('button', { name: /toggle blueprint/i }))

  await waitFor(() => {
    expect(screen.getByText('Add /todos POST endpoint')).toBeInTheDocument()
  })
})
