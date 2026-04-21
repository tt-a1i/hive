// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { WorkerCard } from '../../web/src/worker/WorkerCard.js'
import { startTestServer } from '../helpers/test-server.js'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
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

class PortalTestWebSocket {
  static instances: PortalTestWebSocket[] = []
  readonly OPEN = 1
  closed = false
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  readyState = 1

  constructor(readonly url: string) {
    PortalTestWebSocket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }

  close() {
    this.closed = true
  }
  send() {}
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const globalsCssPath = resolve(moduleDir, '../../web/src/styles/globals.css')
const globalsCss = readFileSync(globalsCssPath, 'utf8')

/**
 * Linear tokens rendered in `globals.css` use Tailwind v4 `@theme` which vite processes
 * at build time. jsdom does not run tailwind, so we synthesise the runtime :root block
 * from the same source file the app ships. We strip the `@theme` / `@import` pragmas
 * (jsdom cannot parse them) and keep the concrete `:root {}` block that defines
 * --accent and sibling tokens.
 */
const buildStylesheet = (source: string): string => {
  const rootMatch = source.match(/:root\s*\{[\s\S]*?\}/)
  if (!rootMatch) throw new Error('Could not extract :root block from globals.css')
  return rootMatch[0]
}

let styleEl: HTMLStyleElement | null = null

beforeAll(() => {
  styleEl = document.createElement('style')
  styleEl.setAttribute('data-testid', 'm5-linear-tokens')
  styleEl.textContent = buildStylesheet(globalsCss)
  document.head.appendChild(styleEl)

  // jsdom has no matchMedia; @xterm/xterm calls it during open(). The vi.mock
  // above replaces the module for tests that go through static imports, but
  // useTerminalRun loads xterm via dynamic import() which can race past the
  // mock in vitest's worker. Stubbing matchMedia is the cheapest way to keep
  // teardown free of unhandled rejections.
  if (!window.matchMedia) {
    window.matchMedia = (_query: string) =>
      ({
        matches: false,
        media: _query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
})

afterAll(() => {
  styleEl?.remove()
  styleEl = null
})

let cleanupServer: (() => Promise<void>) | undefined
const nativeFetch = globalThis.fetch

beforeEach(async () => {
  const server = await startTestServer()
  cleanupServer = server.close
  let cookie = ''
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    cookie = response.headers.get('set-cookie') ?? ''
  })
  await nativeFetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alpha', path: '/tmp/hive-m5-alpha' }),
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${server.baseUrl}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return nativeFetch(url, { ...init, headers })
  })
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
})

describe('M5 Linear dark visual contract', () => {
  test('exposes --accent token at #5e6ad2 on :root', () => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    expect(accent).toBe('#5e6ad2')
  })

  test('active sidebar row carries inset accent stripe', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-current', 'true')
    })
    const activeRow = screen.getByRole('button', { name: 'Alpha' })
    expect(activeRow.className).toContain('active')

    const stripeSource = globalsCss
      .split(/\r?\n/)
      .find((line) => line.includes('inset 3px 0 0 var(--accent)'))
    expect(stripeSource).toBeDefined()
  })

  test('worker grid renders and card click opens the worker modal', async () => {
    const worker = {
      id: 'agent-x',
      name: 'Alice',
      pendingTaskCount: 0,
      role: 'coder' as const,
      status: 'working' as const,
    }
    const handleClick = vi.fn()
    render(<WorkerCard worker={worker} onClick={handleClick} />)

    const card = screen.getByTestId('worker-card-agent-x')
    expect(card).toBeInTheDocument()
    fireEvent.click(card)
    expect(handleClick).toHaveBeenCalledWith(worker)
  })

  test('TerminalView portals into orch-pty-{runId} when a matching slot is in the DOM', async () => {
    vi.stubGlobal('WebSocket', PortalTestWebSocket as never)
    const { TerminalView } = await import('../../web/src/terminal/TerminalView.js')
    const slot = document.createElement('div')
    slot.id = 'orch-pty-run-1'
    document.body.appendChild(slot)

    render(<TerminalView runId="run-1" title="orch" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-1"]')).not.toBeNull()
    })
    expect(document.querySelector('section[aria-label="Terminal orch"]')).toBeNull()
    slot.remove()
  })

  test('TerminalView portals into worker-pty-{runId} slot when worker modal is open', async () => {
    vi.stubGlobal('WebSocket', PortalTestWebSocket as never)
    const { TerminalView } = await import('../../web/src/terminal/TerminalView.js')
    const slot = document.createElement('div')
    slot.id = 'worker-pty-run-2'
    document.body.appendChild(slot)

    render(<TerminalView runId="run-2" title="worker" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-2"]')).not.toBeNull()
    })
    slot.remove()
  })

  test('clicking a card in the App mounts a worker-modal element', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-current', 'true')
    })

    // Open the AddWorkerDialog via the Workers pane header button
    const newWorkerButtons = screen.getAllByRole('button', { name: /New Worker/ })
    fireEvent.click(newWorkerButtons[0] as HTMLElement)

    const dialog = await screen.findByRole('form', { name: 'Add worker' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Alice' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    const card = await screen.findByRole('button', { name: /^Open Alice$/ })
    fireEvent.click(card)

    await waitFor(() => {
      expect(screen.getByTestId('worker-modal')).toBeInTheDocument()
    })
  })
})
