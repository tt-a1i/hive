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
const nativeFetch = globalThis.fetch
const tempDirs: string[] = []
let fetchCalls: Array<{ method: string; pathname: string }> = []

beforeEach(async () => {
  window.localStorage.removeItem?.('hive.workspace-sidebar.width')
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-app-shell-fs-'))
  mkdirSync(join(sandboxRoot, 'placeholder'), { recursive: true })
  tempDirs.push(sandboxRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot

  const server = await startTestServer({
    pickFolderPath: join(sandboxRoot, 'placeholder'),
  })
  cleanupServer = server.close
  let cookie = ''
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
    expect(screen.getByTestId('topbar-settings')).toHaveTextContent('Notifications')
    fireEvent.click(screen.getByTestId('topbar-settings'))
    expect(screen.getByTestId('notification-settings')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Sound' })).toBeInTheDocument()

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
