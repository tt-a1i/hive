// @vitest-environment jsdom
//
// M5b impl:shell — the AppInner switch. At a narrow breakpoint the app renders
// MobileShell (bottom nav + section routing); at wide it renders the existing
// 3-column layout UNCHANGED. The switch is driven purely by the layout-mode
// context, derived from matchMedia at the root mount.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { APP_VERSION } from '../../web/src/version.js'
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

const stubMatchMedia = (matches: boolean) => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(
      (query: string) =>
        ({
          matches,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    )
  )
}

beforeEach(async () => {
  window.localStorage?.clear?.()
  window.localStorage.setItem('hive.first-run-seen', '1')
  window.localStorage.setItem('hive.last-seen-version', APP_VERSION)
  const server = await startTestServer({ offlineVersionCheck: true })
  cleanupServer = server.close
  serverBaseUrl = server.baseUrl
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    uiCookie = response.headers.get('set-cookie') ?? ''
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${serverBaseUrl}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', uiCookie)
    return nativeFetch(url, { ...init, headers })
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

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
  window.localStorage?.clear?.()
})

describe('mobile shell at a narrow breakpoint', () => {
  test('renders MobileShell with its bottom nav and NOT the desktop 3-column layout', async () => {
    stubMatchMedia(true)
    render(<App />)

    await screen.findByTestId('mobile-bottom-nav')

    expect(screen.getByTestId('mobile-shell')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-nav-team')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-nav-tasks')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-nav-settings')).toBeNull()
    // The orchestrator lives stacked inside Team on mobile, so there is no
    // separate Chat tab (every visible tab must route to real content).
    expect(screen.queryByTestId('mobile-nav-chat')).toBeNull()

    // The desktop-only chrome must NOT be present in the mobile tree: the
    // resizer separator is a desktop affordance, and the workspace sidebar
    // title lives in the desktop sidebar header (its own slide-over sheet on
    // mobile is closed by default).
    expect(screen.queryByRole('separator', { name: 'Resize Workspace sidebar' })).toBeNull()
    expect(screen.queryByTestId('workspace-sidebar-title')).toBeNull()
  })

  test('switching the active section swaps the visible panel', async () => {
    stubMatchMedia(true)
    render(<App />)
    await screen.findByTestId('mobile-bottom-nav')

    // Team is the default landing section.
    const teamSection = screen.getByTestId('mobile-section-team')
    expect(teamSection).toBeInTheDocument()
    expect(teamSection.className).toContain('overflow-hidden')
    expect(screen.queryByTestId('mobile-section-tasks')).toBeNull()

    fireEvent.click(screen.getByTestId('mobile-nav-tasks'))
    await waitFor(() => {
      expect(screen.getByTestId('mobile-section-tasks')).toBeInTheDocument()
    })
    expect(screen.getByTestId('mobile-section-tasks').className).toContain('overflow-y-auto')
    // Reversed routing (section never switches) would keep Team mounted.
    expect(screen.queryByTestId('mobile-section-team')).toBeNull()
  })

  test('hosts the mobile topbar so update prompts + chrome have a home', async () => {
    stubMatchMedia(true)
    render(<App />)
    await screen.findByTestId('mobile-bottom-nav')
    expect(screen.getByTestId('mobile-topbar')).toBeInTheDocument()
  })
})
