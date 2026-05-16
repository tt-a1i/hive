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
const nativeFetch = globalThis.fetch
const tempDirs: string[] = []

beforeEach(async () => {
  window.localStorage.setItem('hive.first-run-seen', '1')
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-fs-sandbox-'))
  mkdirSync(join(sandboxRoot, 'alpha-project'), { recursive: true })
  tempDirs.push(sandboxRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot

  const server = await startTestServer({
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
  cleanupServer = undefined
  delete process.env.HIVE_FS_BROWSE_ROOT
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('workspace create initial state', () => {
  test('newly created workspace immediately shows the Linear workspace view with empty drawer', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('No Workspaces')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'New Workspace' }))

    const confirm = await screen.findByTestId('confirm-workspace-dialog')
    fireEvent.change(within(confirm).getByTestId('confirm-workspace-name'), {
      target: { value: 'Alpha' },
    })
    fireEvent.click(within(confirm).getByTestId('confirm-workspace-startup-toggle'))
    fireEvent.change(within(confirm).getByTestId('confirm-workspace-startup-command'), {
      target: { value: `${process.execPath} -e "process.stdin.resume()"` },
    })
    const createButton = within(confirm).getByTestId('confirm-workspace-create')
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
      realpathSync(join(sandboxRoot, 'alpha-project'))
    )
    expect(screen.queryByRole('contentinfo')).toBeNull()

    const drawer = screen.getByTestId('task-graph-drawer')
    expect(within(drawer).queryByTestId('task-graph-list')).toBeNull()
    expect(within(drawer).getByText(/No tasks yet/i)).toBeInTheDocument()
  }, 20000)
})
