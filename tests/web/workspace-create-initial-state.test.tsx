// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
let server: Awaited<ReturnType<typeof startTestServer>>
let sandboxRoot = ''
const nativeFetch = globalThis.fetch
const tempDirs: string[] = []

beforeEach(async () => {
  // This scenario uses the native-picker service fixture. Windows clients
  // deliberately use the server directory browser instead.
  vi.stubGlobal('navigator', {
    language: 'en-US',
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  })
  window.localStorage.setItem('hive.first-run-seen', '1')
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-fs-sandbox-'))
  mkdirSync(join(sandboxRoot, 'alpha-project'), { recursive: true })
  tempDirs.push(sandboxRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot

  server = await startTestServer({
    pickFolderPath: join(sandboxRoot, 'alpha-project'),
  })
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
  vi.unstubAllGlobals()
  cleanupServer = undefined
  delete process.env.HIVE_FS_BROWSE_ROOT
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('workspace create initial state', () => {
  test('newly created workspace shows the Linear workspace view and opens an empty tasks dialog', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('No Workspaces')).toBeInTheDocument()
    })
    fireEvent.click(
      within(screen.getByTestId('empty-state')).getByRole('button', { name: 'New Workspace' })
    )

    const confirmDialog = await screen.findByTestId('confirm-workspace-dialog')
    const nameInput = within(confirmDialog).getByTestId('confirm-workspace-name')
    await waitFor(() => expect(nameInput).toBeEnabled(), { timeout: 15000 })
    fireEvent.change(nameInput, {
      target: { value: 'Alpha' },
    })
    fireEvent.click(within(confirmDialog).getByTestId('confirm-workspace-startup-toggle'))
    fireEvent.change(within(confirmDialog).getByTestId('confirm-workspace-startup-command'), {
      target: { value: `${process.execPath} -e "process.stdin.resume()"` },
    })
    const createButton = within(confirmDialog).getByTestId('confirm-workspace-create')
    await waitFor(() => expect(createButton).toBeEnabled(), { timeout: 15000 })
    fireEvent.click(createButton)

    await waitFor(
      () => {
        expect(
          screen
            .getAllByRole('button', { name: 'Alpha' })
            .find((b) => b.classList.contains('ws-row'))
        ).toHaveAttribute('aria-current', 'true')
      },
      { timeout: 15000 }
    )

    // Sub-header and footer were removed in M6 polish. Workspace identity
    // lives in the sidebar row — name shown inline, path on the row's
    // hover Tooltip so the chip stays compact. The path is mirrored onto a
    // `data-workspace-path` attribute so tests can assert without driving
    // Radix Tooltip's hover state.
    const rowButton = screen
      .getAllByRole('button', { name: 'Alpha' })
      .find((b) => b.classList.contains('ws-row'))
    expect(rowButton).toHaveAttribute(
      'data-workspace-path',
      realpathSync.native(join(sandboxRoot, 'alpha-project'))
    )
    expect(screen.queryByRole('contentinfo')).toBeNull()

    expect(screen.queryByTestId('task-graph-drawer')).toBeNull()
    fireEvent.click(screen.getByTestId('topbar-blueprint'))
    const drawer = await screen.findByTestId('task-graph-drawer')
    expect(within(drawer).queryByTestId('task-graph-list')).toBeNull()
    expect(within(drawer).getByText(/No tasks yet/i)).toBeInTheDocument()

    // Creating the workspace also starts the configured real PTY. Verify its
    // startup barrier before teardown, rather than killing a pending startup.
    const created = server.store.listWorkspaces().find((item) => item.name === 'Alpha')
    if (!created) throw new Error('Created workspace missing from runtime')
    const run = server.store.getActiveRunByAgentId(created.id, `${created.id}:orchestrator`)
    if (!run) throw new Error('Created workspace has no active orchestrator run')
    await run.postStartInputReady
    expect(run.startupReadyAt).toBeTypeOf('number')
  }, 20000)
})
