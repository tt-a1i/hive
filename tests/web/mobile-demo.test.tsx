// @vitest-environment jsdom
//
// M5b impl:wiring — Parity row "Demo mode" on mobile. Demo is a pure client
// path that must be reachable from the phone shell, not just the desktop
// 3-column tree. With the breakpoint matchMedia matching, <App/> renders the
// MobileShell; entering demo (via the manifest shortcut entry / Try Demo CTA in
// the welcome pane it hosts) must surface the demo workspace inside that shell.
// Reversed (demo gated behind a desktop-only entry) → no demo-banner on mobile.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'

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

// Force the mobile breakpoint so <App/>'s matchMedia-derived LayoutModeProvider
// resolves to { mode: 'mobile' } and AppInner takes the MobileShell branch.
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

beforeEach(() => {
  window.localStorage?.clear?.()
  window.localStorage.setItem('hive.first-run-seen', '1')
  stubMobileMatchMedia()
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const path =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname
    const bodies: Record<string, unknown> = {
      '/api/ui/session': {},
      '/api/workspaces': [],
      '/api/settings/app-state/active_workspace_id': { key: 'active_workspace_id', value: null },
      '/api/settings/workflow-feature': { enabled: false },
      '/api/version': {
        current_version: '0.0.0',
        latest_version: '0.0.0',
        update_available: false,
      },
    }
    return Promise.resolve(
      new Response(JSON.stringify(bodies[path] ?? {}), {
        status: path in bodies ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      })
    )
  })
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage?.clear?.()
})

test('mobile: Try Demo enters demo mode inside the MobileShell', async () => {
  render(<App />)

  // The phone shell is what frames the welcome pane.
  await waitFor(() => {
    expect(document.querySelector('[data-mobile-shell="true"]')).toBeTruthy()
  })
  await screen.findByTestId('welcome-pane')

  fireEvent.click(screen.getByRole('button', { name: /try the demo/i }))

  // Demo workspace renders inside the same mobile shell — not a desktop-only entry.
  expect(screen.getByTestId('demo-banner')).toBeInTheDocument()
  expect(screen.getByTestId('demo-replay-panel')).toBeInTheDocument()
  expect(document.querySelector('[data-mobile-shell="true"]')).toBeTruthy()
})
