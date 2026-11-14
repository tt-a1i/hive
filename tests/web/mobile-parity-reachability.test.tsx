// @vitest-environment jsdom
//
// M5b impl:wiring — Parity-Matrix REACHABILITY through the real mobile shell.
// The component-level page tests (mobile-tasks-page / mobile-workflows-page)
// prove the drawers render full-bleed in isolation, but they never prove the
// task UI is REACHABLE on a phone. These tests render the full <App/> at the
// mobile breakpoint with a real seeded workspace and navigate the bottom nav:
//   - Tasks tab  → the task graph section opens + a toggle persists
//   - every rendered bottom-nav tab yields non-empty content (no dead nav)
// Reversed (tabs route to empty sections, as before this fix) → these fail.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { App } from '../../web/src/app.js'
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
let baseUrl = ''
let uiCookie = ''
let workspaceId = ''
let workspacePath = ''
const tempDirs: string[] = []

const stubMobileMatchMedia = () => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('max-width'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent() {
          return false
        },
      }) as unknown as MediaQueryList
  )
}

class ForwardedWebSocket {
  readonly OPEN = 1
  private socket: WebSocket
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null

  constructor(url: string) {
    const parsed = new URL(url, 'http://localhost')
    const resolvedUrl = `${baseUrl.replace('http://', 'ws://')}${parsed.pathname}${parsed.search}`
    this.socket = new WebSocket(resolvedUrl, { headers: { cookie: uiCookie } })
    this.socket.on('open', () => this.onopen?.())
    this.socket.on('message', (data) => this.onmessage?.({ data: data.toString() }))
    this.socket.on('close', () => this.onclose?.())
    this.socket.on('error', () => this.onerror?.())
  }

  close() {
    this.socket.close()
  }

  get readyState() {
    return this.socket.readyState
  }

  send(payload: string) {
    this.socket.send(payload)
  }
}

beforeEach(async () => {
  window.localStorage?.clear?.()
  window.localStorage.setItem('hive.first-run-seen', '1')
  stubMobileMatchMedia()
  const server = await startTestServer({ offlineVersionCheck: true })
  cleanupServer = server.close
  baseUrl = server.baseUrl
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    uiCookie = response.headers.get('set-cookie') ?? ''
  })
  workspacePath = mkdtempSync(join(tmpdir(), 'hive-mobile-parity-'))
  tempDirs.push(workspacePath)
  const workspaceResponse = await nativeFetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alpha', path: workspacePath, autostart_orchestrator: false }),
  })
  workspaceId = ((await workspaceResponse.json()) as { id: string }).id
  await nativeFetch(`${server.baseUrl}/api/workspaces/${workspaceId}/tasks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ content: '- [ ] implement login\n' }),
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${server.baseUrl}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', uiCookie)
    return nativeFetch(url, { ...init, headers })
  })
  vi.stubGlobal('WebSocket', ForwardedWebSocket as never)
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await cleanupServer?.()
  cleanupServer = undefined
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
  window.localStorage?.clear?.()
})

test('Tasks tab opens the task graph section and a toggle persists to .hive/tasks.md', async () => {
  render(<App />)
  await screen.findByTestId('mobile-bottom-nav')

  // Before tapping Tasks the graph content is not mounted.
  expect(screen.queryByTestId('task-graph-content')).toBeNull()

  fireEvent.click(screen.getByTestId('mobile-nav-tasks'))

  // The task graph must be REACHABLE through the shell, not just in isolation.
  expect(await screen.findByTestId('mobile-section-tasks')).toBeInTheDocument()
  expect(await screen.findByTestId('task-graph-content')).toBeInTheDocument()
  const checkbox = await screen.findByTestId('task-checkbox-0')
  expect(checkbox).not.toBeChecked()

  // And invokable: toggling persists through the tunnel-agnostic API.
  fireEvent.click(checkbox)
  await waitFor(async () => {
    const saved = await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
      headers: { cookie: uiCookie },
    })
    await expect(saved.json()).resolves.toEqual({ content: '- [x] implement login\n' })
  })
  expect(screen.queryByTestId('task-graph-drawer')).toBeNull()
})

test('every rendered bottom-nav tab routes to real reachable content (no dead nav)', async () => {
  render(<App />)
  await screen.findByTestId('mobile-bottom-nav')

  // Team: the workspace switcher sits in the topbar and WorkspaceDetail panes render in-section.
  fireEvent.click(screen.getByTestId('mobile-nav-team'))
  expect(screen.getByTestId('mobile-workspace-switcher-trigger')).toBeInTheDocument()
  expect(await screen.findByTestId('workspace-detail-panes')).toBeInTheDocument()
  const teamSection = await screen.findByTestId('mobile-section-team')
  expect(teamSection).toContainElement(screen.getByTestId('workspace-detail-panes'))

  // Tasks: the task graph section opens.
  fireEvent.click(screen.getByTestId('mobile-nav-tasks'))
  const tasksSection = await screen.findByTestId('mobile-section-tasks')
  expect(tasksSection).toContainElement(await screen.findByTestId('task-graph-content'))

  // No hidden/dead tabs should be rendered.
  expect(screen.queryByTestId('mobile-nav-flows')).toBeNull()
  expect(screen.queryByTestId('mobile-nav-settings')).toBeNull()
})
