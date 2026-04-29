// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
let sandboxRoot = ''
const nativeFetch = globalThis.fetch
const tempDirs: string[] = []

beforeEach(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-app-shell-fs-'))
  mkdirSync(join(sandboxRoot, 'placeholder'), { recursive: true })
  tempDirs.push(sandboxRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot
  process.env.HIVE_MOCK_PICK_FOLDER = join(sandboxRoot, 'placeholder')

  const server = await startTestServer()
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
  delete process.env.HIVE_FS_BROWSE_ROOT
  delete process.env.HIVE_MOCK_PICK_FOLDER
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('app shell with real server', () => {
  test('renders Linear dark shell + auto-opens native picker → compact confirm on empty state', async () => {
    render(<App />)

    const banner = screen.getByRole('banner')
    expect(banner).toHaveClass('h-11')
    expect(banner.textContent ?? '').toContain('Hive')

    // Empty state fires POST /api/fs/pick-folder (mocked to return the sandbox dir),
    // which resolves to the compact confirm dialog — not the server-browse dialog.
    await waitFor(() => {
      expect(screen.getByTestId('confirm-workspace-dialog')).toBeInTheDocument()
    })
    expect(screen.getByRole('dialog', { name: 'Confirm workspace' })).toBeInTheDocument()
    expect(screen.getByTestId('confirm-workspace-create')).toBeInTheDocument()
    expect(screen.queryByTestId('add-workspace-dialog')).toBeNull()

    const sidebar = screen.getByRole('complementary', { name: 'Workspace sidebar' })
    expect(sidebar).toHaveClass('w-56')
    expect(sidebar.closest('.h-screen')).toBeInTheDocument()

    expect(screen.getByRole('contentinfo')).toHaveClass('h-6')
  })

  test('workspace sidebar can collapse to a narrow rail and expand again', async () => {
    render(<App />)

    const sidebar = screen.getByRole('complementary', { name: 'Workspace sidebar' })
    expect(sidebar).toHaveClass('w-56')
    expect(sidebar).toHaveAttribute('data-collapsed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse workspace sidebar' }))

    expect(sidebar).toHaveClass('w-14')
    expect(sidebar).toHaveAttribute('data-collapsed', 'true')
    expect(screen.queryByLabelText('Workspaces')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Expand workspace sidebar' }))

    expect(sidebar).toHaveClass('w-56')
    expect(sidebar).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByLabelText('Workspaces')).toBeInTheDocument()
  })
})
