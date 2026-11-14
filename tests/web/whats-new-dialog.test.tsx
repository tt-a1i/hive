// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { APP_VERSION } from '../../web/src/version.js'
import { CHANGELOG } from '../../web/src/whats-new/changelog.js'
import { useWhatsNew } from '../../web/src/whats-new/useWhatsNew.js'
import { WhatsNewDialog } from '../../web/src/whats-new/WhatsNewDialog.js'
import { startTestServer } from '../helpers/test-server.js'

const KEY = 'hive.last-seen-version'
const POST_LEGACY_VERSIONS = CHANGELOG.filter(
  (entry) => Number(entry.version.split('.')[0]) >= 2
).map((entry) => entry.version)

afterEach(() => cleanup())

// ─── useWhatsNew hook ───────────────────────────────────────────────────────

test('opens on upgrade, records current version only on close', () => {
  window.localStorage.clear()
  window.localStorage.setItem(KEY, '1.0.0')

  const { result } = renderHook(() =>
    useWhatsNew({ hasExistingWorkspace: false, wizardOpen: false })
  )

  expect(result.current.open).toBe(true)
  expect(result.current.entries.length).toBeGreaterThan(0)
  // Not recorded yet — only on dismiss.
  expect(window.localStorage.getItem(KEY)).toBe('1.0.0')

  act(() => result.current.close())

  expect(result.current.open).toBe(false)
  expect(window.localStorage.getItem(KEY)).toBe(APP_VERSION)
})

test('defers while the wizard is open without recording the version, then shows', () => {
  window.localStorage.clear()
  window.localStorage.setItem(KEY, '1.0.0')

  const { result, rerender } = renderHook(
    ({ wizardOpen }) => useWhatsNew({ hasExistingWorkspace: false, wizardOpen }),
    {
      initialProps: { wizardOpen: true },
    }
  )

  expect(result.current.open).toBe(false)
  // The upgrade popup must NOT be swallowed by deferring for the wizard.
  expect(window.localStorage.getItem(KEY)).toBe('1.0.0')

  rerender({ wizardOpen: false })

  expect(result.current.open).toBe(true)
})

test('fresh install seeds the version silently and does not show', () => {
  window.localStorage.clear()

  const { result } = renderHook(() =>
    useWhatsNew({ hasExistingWorkspace: false, wizardOpen: false })
  )

  expect(result.current.open).toBe(false)
  expect(window.localStorage.getItem(KEY)).toBe(APP_VERSION)
})

test('existing 1.7 users with workspaces but no last-seen key still see cumulative notes since 1.7', () => {
  window.localStorage.clear()

  const { result } = renderHook(() =>
    useWhatsNew({ hasExistingWorkspace: true, wizardOpen: false })
  )

  expect(result.current.open).toBe(true)
  expect(result.current.entries.map((entry) => entry.version)).toEqual(POST_LEGACY_VERSIONS)
  expect(window.localStorage.getItem(KEY)).toBeNull()
})

test('workspace bootstrap pending does not seed last-seen before legacy detection can run', () => {
  window.localStorage.clear()

  const { result, rerender } = renderHook(
    ({ hasExistingWorkspace }) => useWhatsNew({ hasExistingWorkspace, wizardOpen: false }),
    { initialProps: { hasExistingWorkspace: null as boolean | null } }
  )

  expect(result.current.open).toBe(false)
  expect(window.localStorage.getItem(KEY)).toBeNull()

  rerender({ hasExistingWorkspace: true })

  expect(result.current.open).toBe(true)
  expect(result.current.entries.map((entry) => entry.version)).toEqual(POST_LEGACY_VERSIONS)
  expect(window.localStorage.getItem(KEY)).toBeNull()
})

// ─── WhatsNewDialog component ────────────────────────────────────────────────

test('renders bilingual highlights and Got it triggers onClose', () => {
  const onClose = vi.fn()
  render(
    <WhatsNewDialog
      open
      entries={[{ version: '1.4.4', date: '2026-05-30', en: ['Shiny new thing'], zh: ['新东西'] }]}
      onClose={onClose}
    />
  )

  expect(screen.getByText('Shiny new thing')).toBeInTheDocument()
  expect(screen.getByText(/version 1\.4\.4/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /got it/i }))
  expect(onClose).toHaveBeenCalledOnce()
})

// ─── App wiring: AppInner → AppOverlays → WhatsNewDialog ──────────────────────

const nativeFetch = globalThis.fetch
let cleanupServer: (() => Promise<void>) | undefined
let serverContext: Awaited<ReturnType<typeof startTestServer>> | undefined
const tempDirs: string[] = []

beforeEach(async () => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-whats-new-'))
  mkdirSync(join(sandboxRoot, 'placeholder'), { recursive: true })
  tempDirs.push(sandboxRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot

  const server = await startTestServer({ pickFolderPath: join(sandboxRoot, 'placeholder') })
  serverContext = server
  cleanupServer = server.close
  let cookie = ''
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    cookie = response.headers.get('set-cookie') ?? ''
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
  serverContext = undefined
  delete process.env.HIVE_FS_BROWSE_ROOT
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

test('App shows What’s New after an upgrade and records the version on dismiss', async () => {
  // First-run wizard already seen (so it does not pre-empt), upgraded from an
  // old version (so there are changelog entries to show).
  window.localStorage.clear()
  window.localStorage.setItem('hive.first-run-seen', '1')
  window.localStorage.setItem(KEY, '1.0.0')

  render(<App />)

  const dialog = await screen.findByRole('dialog', { name: /what’s new|what's new/i })
  expect(dialog).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /got it/i }))

  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: /what’s new|what's new/i })).toBeNull()
  )
  expect(window.localStorage.getItem(KEY)).toBe(APP_VERSION)
})

test('App treats existing workspaces without last-seen as a 1.7 upgrade and shows cumulative notes', async () => {
  const sandboxRoot = tempDirs[0]
  if (!sandboxRoot || !serverContext) throw new Error('Expected test server')
  const existingPath = join(sandboxRoot, 'existing-project')
  mkdirSync(existingPath, { recursive: true })
  serverContext.store.createWorkspace(existingPath, 'Existing')
  window.localStorage.clear()

  render(<App />)

  const dialog = await screen.findByRole('dialog', { name: /what’s new|what's new/i })
  expect(dialog).toBeInTheDocument()
  for (const version of POST_LEGACY_VERSIONS) {
    expect(
      screen.getByText(new RegExp(`^version ${version.replaceAll('.', '\\.')}$`, 'i'))
    ).toBeInTheDocument()
  }
  expect(window.localStorage.getItem(KEY)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: /got it/i }))

  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: /what’s new|what's new/i })).toBeNull()
  )
  expect(window.localStorage.getItem(KEY)).toBe(APP_VERSION)
})
