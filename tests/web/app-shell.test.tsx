// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
let sandboxRoot = ''
let baseUrl = ''
let cookie = ''
const nativeFetch = globalThis.fetch
const tempDirs: string[] = []
let fetchCalls: Array<{ method: string; pathname: string }> = []

beforeEach(async () => {
  // Native-picker scenarios require an explicit client platform, independent
  // of the host OS running jsdom. Windows has a separate server-browser route.
  vi.stubGlobal('navigator', {
    language: 'en-US',
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  })
  window.localStorage.removeItem?.('hive.workspace-sidebar.width')
  window.localStorage.setItem('hive.first-run-seen', '1')
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-app-shell-fs-'))
  mkdirSync(join(sandboxRoot, 'placeholder'), { recursive: true })
  tempDirs.push(sandboxRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot

  const server = await startTestServer({
    pickFolderPath: join(sandboxRoot, 'placeholder'),
  })
  cleanupServer = server.close
  baseUrl = server.baseUrl
  cookie = ''
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    cookie = response.headers.get('set-cookie') ?? ''
  })
  fetchCalls = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${server.baseUrl}${value}`
    const parsed = new URL(url)
    fetchCalls.push({ method: init?.method ?? 'GET', pathname: parsed.pathname })
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
  vi.unstubAllGlobals()
  delete process.env.HIVE_FS_BROWSE_ROOT
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('app shell with real server', () => {
  test('Windows welcome CTA browses real server directories without a native picker', async () => {
    vi.stubGlobal('navigator', {
      language: 'en-US',
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    })
    render(<App />)
    await screen.findByTestId('welcome-pane')
    fireEvent.click(screen.getByRole('button', { name: /add your first workspace/i }))
    const dialog = await screen.findByTestId('add-workspace-dialog')
    expect(await within(dialog).findByTestId('fs-entry-placeholder')).toBeInTheDocument()
    expect(within(dialog).getByTestId('fs-root-path')).toHaveTextContent(
      realpathSync.native(sandboxRoot)
    )
    expect(screen.queryByTestId('confirm-workspace-dialog')).toBeNull()
    expect(fetchCalls).not.toContainEqual({ method: 'POST', pathname: '/api/fs/pick-folder' })
  })

  test('renders Linear dark shell without auto-opening the folder picker on empty state', async () => {
    render(<App />)

    const banner = screen.getByRole('banner')
    expect(banner).toHaveClass('h-11')
    expect(banner.textContent ?? '').toContain('Hive')
    // Empty state hides Topbar actions so first-run users only see the brand
    // and the central Welcome CTA.
    expect(screen.queryByTestId('topbar-settings')).toBeNull()
    expect(screen.queryByTestId('topbar-blueprint')).toBeNull()

    await waitFor(() => {
      expect(screen.getByText('No Workspaces')).toBeInTheDocument()
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByTestId('confirm-workspace-dialog')).toBeNull()
    expect(screen.queryByTestId('add-workspace-dialog')).toBeNull()
    expect(fetchCalls).not.toContainEqual({ method: 'POST', pathname: '/api/fs/pick-folder' })

    expect(screen.queryByTestId('sidebar-empty-compact-add')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /add your first workspace/i }))
    const confirmDialog = await screen.findByTestId('confirm-workspace-dialog')
    expect(within(confirmDialog).getByTestId('confirm-workspace-create')).toBeInTheDocument()
    expect(within(confirmDialog).getByTestId('confirm-workspace-path')).toHaveValue(
      join(sandboxRoot, 'placeholder')
    )
    expect(fetchCalls).toContainEqual({ method: 'POST', pathname: '/api/fs/pick-folder' })

    // Radix Dialog locks the rest of the tree (aria-hidden) — query with
    // `hidden: true` so testing-library traverses past the inert node.
    const sidebar = screen.getByRole('complementary', {
      name: 'Workspace sidebar',
      hidden: true,
    })
    expect(sidebar).toHaveStyle({ width: '56px' })
    expect(sidebar.closest('.h-screen')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-empty-compact-add')).toBeNull()
    expect(screen.queryByRole('contentinfo', { hidden: true })).toBeNull()
  })

  test('empty state renders WelcomePane in main area and CTA opens add dialog', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('welcome-pane')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /add your first workspace/i }))
    expect(await screen.findByTestId('confirm-workspace-dialog')).toBeInTheDocument()
    expect(fetchCalls).toContainEqual({ method: 'POST', pathname: '/api/fs/pick-folder' })
  })

  test('workspace create failure keeps dialog open and surfaces error toast', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = value.startsWith('http') ? value : `${baseUrl}${value}`
      const parsed = new URL(url)
      fetchCalls.push({ method: init?.method ?? 'GET', pathname: parsed.pathname })
      if (parsed.pathname === '/api/workspaces' && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Failed to create workspace' }), {
            headers: { 'content-type': 'application/json' },
            status: 500,
          })
        )
      }
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(url, { ...init, headers })
    })

    render(<App />)
    await screen.findByTestId('welcome-pane')
    fireEvent.click(screen.getByRole('button', { name: /add your first workspace/i }))
    const confirmDialog = await screen.findByTestId('confirm-workspace-dialog')
    fireEvent.click(within(confirmDialog).getByTestId('confirm-workspace-startup-toggle'))
    fireEvent.change(within(confirmDialog).getByTestId('confirm-workspace-startup-command'), {
      target: { value: `${process.execPath} -e "process.stdin.resume()"` },
    })
    const createButton = within(confirmDialog).getByTestId('confirm-workspace-create')
    await waitFor(() => expect(createButton).toBeEnabled(), { timeout: 15000 })
    fireEvent.click(createButton)

    expect(
      await screen.findByTestId('add-workspace-error', undefined, { timeout: 15000 })
    ).toBeInTheDocument()
    expect(screen.getByTestId('add-workspace-error')).toHaveTextContent(
      /failed to create workspace/i
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to create workspace/i)
  }, 20000)

  test('init failure surfaces error toast and swaps the workspace area for the runtime-offline page', async () => {
    // Override the per-test fetch stub from beforeEach with a hard-rejecting
    // one so bootstrap fails on the first call.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    render(<App />)
    // Toast surfaces the failure (mid-session error path remains intact).
    await waitFor(() => {
      expect(screen.getByTestId('toast')).toHaveTextContent(/could not reach hive runtime/i)
    })
    // Workspace area is replaced by the offline page, which exposes a retry
    // affordance the auto-reconnect timer also drives.
    expect(screen.getByTestId('runtime-offline-page')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-offline-retry')).toBeInTheDocument()
    // WelcomePane never renders in this state — the user shouldn't see a
    // disabled "Add Workspace" button when the daemon is plainly missing.
    expect(screen.queryByTestId('welcome-pane-add')).toBeNull()
  })

  test('workspace sidebar can be resized from its right edge', async () => {
    render(<App />)

    const sidebar = screen.getByRole('complementary', { name: 'Workspace sidebar' })
    expect(sidebar).toHaveStyle({ width: '56px' })
    expect(screen.getByTestId('workspace-sidebar-title')).toHaveTextContent('Workspaces')
    // At the collapsed default the toggle offers to expand, and dragging still works.
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    const separator = screen.getByRole('separator', { name: 'Resize Workspace sidebar' })
    expect(separator).toHaveAttribute('aria-valuenow', '56')

    fireEvent.mouseDown(separator, { clientX: 56 })
    fireEvent.mouseMove(document, { clientX: 280 })

    expect(sidebar).toHaveStyle({ width: '280px' })
    expect(separator).toHaveAttribute('aria-valuenow', '280')

    fireEvent.mouseUp(document)
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })

    expect(sidebar).toHaveStyle({ width: '264px' })
    expect(separator).toHaveAttribute('aria-valuenow', '264')
  })

  test('workspace sidebar toggle snaps between the collapsed and expanded presets', async () => {
    render(<App />)

    const sidebar = screen.getByRole('complementary', { name: 'Workspace sidebar' })
    expect(sidebar).toHaveStyle({ width: '56px' })

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(sidebar).toHaveStyle({ width: '240px' })
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(sidebar).toHaveStyle({ width: '56px' })
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })
})
