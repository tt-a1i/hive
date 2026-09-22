// @vitest-environment jsdom

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

// Same xterm mock pattern as worker-flow.test.tsx — the workflows drawer
// doesn't touch terminals, but the App tree still constructs them for the
// workspace view, and jsdom can't instantiate WebGL.
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
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

let cleanupServer: (() => Promise<void>) | undefined
let serverContext: Awaited<ReturnType<typeof startTestServer>> | undefined
let uiCookie = ''
const nativeFetch = globalThis.fetch

const stubFetch = (baseUrl: string) => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${baseUrl}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', uiCookie)
    return nativeFetch(url, { ...init, headers })
  })
}

beforeEach(async () => {
  window.localStorage.clear()
  window.localStorage.setItem('hive.first-run-seen', '1')
  window.matchMedia ??= ((query: string) =>
    ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }) as MediaQueryList) as typeof window.matchMedia
  serverContext = await startTestServer()
  cleanupServer = serverContext.close
  await nativeFetch(`${serverContext.baseUrl}/api/ui/session`).then((response) => {
    uiCookie = response.headers.get('set-cookie') ?? ''
  })
  // Workflows ship OFF by default (experimental). These tests exercise the
  // drawer, so opt in before the App's feature provider loads the flag.
  await nativeFetch(`${serverContext.baseUrl}/api/settings/workflow-feature`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ enabled: true }),
  })
  stubFetch(serverContext.baseUrl)
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
  await cleanupServer?.()
  cleanupServer = undefined
  serverContext = undefined
  uiCookie = ''
})

describe('workflows drawer wiring', () => {
  // Workflows are authored + fired by the orchestrator agent, so the drawer is
  // observation-only. This verifies the topbar toggle opens it, the run
  // observation shell renders, and — as a regression guard for the
  // agent-authored-only model — none of the removed human-authoring controls
  // (template gallery, saved-script list + Start, inline editor, Advanced
  // section) are present. End-to-end run execution lives in the
  // Node-environment server suites (esbuild can't transpile in jsdom).
  test('toggle opens an observation-only drawer with no human authoring surface', async () => {
    const ctx = serverContext
    if (!ctx) throw new Error('test server not started')
    const workspacePath = join(ctx.dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })

    const wsResp = await nativeFetch(`${ctx.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'WS', path: workspacePath }),
    })
    expect(wsResp.status).toBe(201)

    render(<App />)

    const workflowsBtn = await screen.findByTestId('topbar-workflows', {}, { timeout: 5000 })
    fireEvent.click(workflowsBtn)

    const drawer = await screen.findByTestId('workflows-drawer', {}, { timeout: 5000 })
    // Observation shell renders: a runs section with the empty state.
    expect(within(drawer).getByText('Recent runs')).toBeInTheDocument()
    expect(within(drawer).getByText(/No runs yet/i)).toBeInTheDocument()
    // The intro teaches that the orchestrator authors workflows.
    expect(drawer.textContent ?? '').toContain('team workflow run')

    // Regression guard: the human authoring surface is gone.
    expect(screen.queryByTestId('workflows-advanced-toggle')).toBeNull()
    expect(screen.queryByTestId('workflow-templates-toggle')).toBeNull()
    expect(screen.queryByTestId('workflows-scripts-section')).toBeNull()
  })

  test('the topbar Workflows button is hidden while the experimental feature is OFF', async () => {
    const ctx = serverContext
    if (!ctx) throw new Error('test server not started')
    // beforeEach opted in; turn workflows back OFF for this case.
    await nativeFetch(`${ctx.baseUrl}/api/settings/workflow-feature`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ enabled: false }),
    })
    const workspacePath = join(ctx.dataDir, 'workspace-off')
    mkdirSync(workspacePath, { recursive: true })
    const wsResp = await nativeFetch(`${ctx.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'WS', path: workspacePath }),
    })
    expect(wsResp.status).toBe(201)

    render(<App />)

    // The Tasks button confirms a workspace is active + the topbar action
    // cluster rendered — so the Workflows button's absence is a real gate,
    // not just the actions being hidden.
    await screen.findByTestId('topbar-blueprint', {}, { timeout: 5000 })
    expect(screen.queryByTestId('topbar-workflows')).toBeNull()
  })
})
