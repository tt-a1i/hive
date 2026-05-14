// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  delete process.env.HIVE_FS_BROWSE_ROOT
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('app shell with real server', () => {
  test('renders Linear dark shell without auto-opening the folder picker on empty state', async () => {
    render(<App />)

    const banner = screen.getByRole('banner')
    expect(banner).toHaveClass('h-11')
    expect(banner.textContent ?? '').toContain('Hive')
    // Empty state hides Topbar actions so first-run users only see the brand
    // and the central Welcome CTA. Notification + Blueprint actions reappear
    // once a workspace is active (covered in worker-flow / tasks-flow tests).
    expect(screen.queryByTestId('topbar-settings')).toBeNull()
    expect(screen.queryByTestId('topbar-blueprint')).toBeNull()

    await waitFor(() => {
      expect(screen.getByText('No workspaces')).toBeInTheDocument()
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByTestId('confirm-workspace-dialog')).toBeNull()
    expect(screen.queryByTestId('add-workspace-dialog')).toBeNull()
    expect(fetchCalls).not.toContainEqual({ method: 'POST', pathname: '/api/fs/pick-folder' })

    fireEvent.click(screen.getByRole('button', { name: 'New workspace' }))
    const confirm = await screen.findByTestId('confirm-workspace-dialog')
    expect(within(confirm).getByTestId('confirm-workspace-create')).toBeInTheDocument()

    // Radix Dialog locks the rest of the tree (aria-hidden) — query with
    // `hidden: true` so testing-library traverses past the inert node.
    const sidebar = screen.getByRole('complementary', {
      name: 'Workspace sidebar',
      hidden: true,
    })
    expect(sidebar).toHaveStyle({ width: '256px' })
    expect(sidebar.closest('.h-screen')).toBeInTheDocument()
    expect(screen.queryByRole('contentinfo', { hidden: true })).toBeNull()
  })

  test('empty state renders WelcomePane in main area and CTA opens add dialog', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('welcome-pane')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /add your first workspace/i }))
    expect(await screen.findByTestId('confirm-workspace-dialog')).toBeInTheDocument()
  })

  test('workspace create failure keeps dialog open and surfaces error toast', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = value.startsWith('http') ? value : `${baseUrl}${value}`
      const parsed = new URL(url)
      fetchCalls.push({ method: init?.method ?? 'GET', pathname: parsed.pathname })
      if (parsed.pathname === '/api/workspaces' && init?.method === 'POST') {
        return Promise.resolve(new Response('{}', { status: 500 }))
      }
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(url, { ...init, headers })
    })

    render(<App />)
    await screen.findByTestId('welcome-pane')
    fireEvent.click(screen.getByRole('button', { name: /add your first workspace/i }))
    const confirm = await screen.findByTestId('confirm-workspace-dialog')
    fireEvent.click(within(confirm).getByTestId('confirm-workspace-create'))

    expect(await screen.findByTestId('add-workspace-error')).toBeInTheDocument()
    expect(screen.getByTestId('add-workspace-error')).toHaveTextContent(
      /failed to create workspace/i
    )
    expect(screen.getByRole('status')).toHaveTextContent(/failed to create workspace/i)
  })

  test('init failure surfaces error toast and disables Add Workspace CTA', async () => {
    // Override the per-test fetch stub from beforeEach with a hard-rejecting
    // one so bootstrap fails on the first call.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    render(<App />)
    // Toast surfaces the failure.
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/could not reach hive runtime/i)
    })
    // WelcomePane Add Workspace CTA becomes disabled so the user cannot
    // trigger a create flow that will fail against an unreachable runtime.
    expect(screen.getByTestId('welcome-pane-add')).toBeDisabled()
    expect(screen.getByTestId('welcome-pane-disabled-reason')).toHaveTextContent(
      /could not reach hive runtime/i
    )
  })

  test('workspace sidebar can be resized from its right edge', async () => {
    render(<App />)

    const sidebar = screen.getByRole('complementary', { name: 'Workspace sidebar' })
    expect(sidebar).toHaveStyle({ width: '256px' })
    expect(screen.getByTestId('workspace-sidebar-title')).toHaveTextContent('Workspaces')
    expect(screen.queryByRole('button', { name: 'Collapse workspace sidebar' })).toBeNull()

    const separator = screen.getByRole('separator', { name: 'Resize workspace sidebar' })
    expect(separator).toHaveAttribute('aria-valuenow', '256')

    fireEvent.mouseDown(separator, { clientX: 256 })
    fireEvent.mouseMove(document, { clientX: 320 })

    expect(sidebar).toHaveStyle({ width: '320px' })
    expect(separator).toHaveAttribute('aria-valuenow', '320')

    fireEvent.mouseUp(document)
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })

    expect(sidebar).toHaveStyle({ width: '304px' })
    expect(separator).toHaveAttribute('aria-valuenow', '304')
  })
})
