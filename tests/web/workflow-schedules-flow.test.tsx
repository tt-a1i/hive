// @vitest-environment jsdom

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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
  // Workflows ship OFF by default (experimental). This suite drives the
  // schedules drawer, so opt in before the App's feature provider loads.
  await nativeFetch(`${serverContext.baseUrl}/api/settings/workflow-feature`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ enabled: true }),
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${serverContext?.baseUrl ?? ''}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', uiCookie)
    return nativeFetch(url, { ...init, headers })
  })
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

describe('workflow schedules — view, toggle, delete via the drawer', () => {
  test('an agent-created schedule shows in the drawer; pause + delete it', async () => {
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
    const ws = (await wsResp.json()) as { id: string }

    // Schedules are created by the orchestrator agent (`team workflow
    // schedule`), which lands as store.scheduleWorkflowInline. Seed one so the
    // drawer's view/control surface has something to act on.
    await ctx.store.scheduleWorkflowInline({
      workspaceId: ws.id,
      source: "export const meta = { name: 'noop', description: 'd' }\nreturn 1",
      name: 'noop',
      cron: '0 9 * * 1',
      nextRunAt: Date.now() + 60_000,
    })

    render(<App />)
    const workflowsBtn = await screen.findByTestId('topbar-workflows', {}, { timeout: 5000 })
    fireEvent.click(workflowsBtn)

    // The drawer polls schedules on open; the agent-created row appears.
    let scheduleRow: HTMLElement | null = null
    await waitFor(
      () => {
        const rows = screen.queryAllByTestId(/^workflow-schedule-row-/)
        expect(rows.length).toBe(1)
        scheduleRow = rows[0] ?? null
        expect(scheduleRow?.getAttribute('data-schedule-enabled')).toBe('true')
      },
      { timeout: 5000 }
    )
    if (!scheduleRow) throw new Error('schedule row did not render')
    const testid = (scheduleRow as HTMLElement).getAttribute('data-testid')
    if (!testid) throw new Error('schedule row missing data-testid')
    const scheduleId = testid.replace('workflow-schedule-row-', '')

    // Pause it → enabled flips to false.
    fireEvent.click(screen.getByTestId(`workflow-schedule-toggle-${scheduleId}`))
    await waitFor(() => {
      const row = screen.getByTestId(`workflow-schedule-row-${scheduleId}`)
      expect(row.getAttribute('data-schedule-enabled')).toBe('false')
    })

    // Delete it → schedule row disappears + the Schedules section unmounts.
    fireEvent.click(screen.getByTestId(`workflow-schedule-delete-${scheduleId}`))
    await waitFor(() => {
      expect(screen.queryByTestId(`workflow-schedule-row-${scheduleId}`)).toBeNull()
    })
  })
})
