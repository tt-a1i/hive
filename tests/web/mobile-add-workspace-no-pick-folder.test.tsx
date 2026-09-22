// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { I18nProvider } from '../../web/src/i18n.js'
import { LayoutModeProvider } from '../../web/src/mobile/layout-mode.js'
import { AddWorkspaceFlow } from '../../web/src/workspace/AddWorkspaceFlow.js'
import type { WorkspaceCreateInput } from '../../web/src/workspace/workspace-create-input.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'

const nativeFetch = globalThis.fetch
let server: Awaited<ReturnType<typeof startTestServer>>
let root: string
let project: string
let cookie: string
let pickerRequests: number
const originalBrowseRoot = process.env.HIVE_FS_BROWSE_ROOT

beforeEach(async () => {
  window.localStorage.clear()
  root = mkdtempSync(join(tmpdir(), 'hive-mobile-create-'))
  project = join(root, 'alpha')
  mkdirSync(project)
  process.env.HIVE_FS_BROWSE_ROOT = root
  pickerRequests = 0
  server = await startTestServer({ pickFolderPath: project })
  server.store.settings.createCommandPreset({
    command: process.execPath,
    args: [],
    displayName: 'Fixture Node',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  })
  const session = await nativeFetch(`${server.baseUrl}/api/ui/session`)
  cookie = session.headers.get('set-cookie') ?? ''
  // Transport adapter only: every request reaches the real HTTP server.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(value, server.baseUrl)
    if (url.pathname === '/api/fs/pick-folder') pickerRequests++
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return nativeFetch(url, { ...init, headers })
  })
})

afterEach(async () => {
  cleanup()
  await server?.close()
  vi.unstubAllGlobals()
  if (originalBrowseRoot === undefined) delete process.env.HIVE_FS_BROWSE_ROOT
  else process.env.HIVE_FS_BROWSE_ROOT = originalBrowseRoot
  if (root) removeTestPath(root)
})

const clientPlatform = (windows: boolean) =>
  vi.stubGlobal('navigator', {
    language: 'en-US',
    platform: windows ? 'Win32' : 'MacIntel',
    userAgent: windows
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  })

const renderFlow = (
  mode: 'mobile' | 'wide',
  onCreate: (input: WorkspaceCreateInput) => Promise<unknown> = async () => undefined
) =>
  render(
    <I18nProvider>
      <LayoutModeProvider value={{ mode }}>
        <AddWorkspaceFlow trigger={1} onClose={() => {}} onCreate={onCreate} />
      </LayoutModeProvider>
    </I18nProvider>
  )

test('mobile creates a real workspace from a typed path without invoking the host picker', async () => {
  clientPlatform(false)
  const transport = globalThis.fetch
  let releaseProbe = () => {}
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve
  })
  onTestFinished(() => releaseProbe())
  // Delay delivery, not the actual HTTP request or response contents. The
  // initial directory probe must arrive after the user has typed another path.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await transport(input, init)
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(value, server.baseUrl).pathname === '/api/fs/probe') await probeGate
    return response
  })
  let createError: unknown
  renderFlow('mobile', async (input) => {
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: input.name, path: input.path, autostart_orchestrator: false }),
      })
      if (!response.ok) throw new Error(`Workspace create failed: ${response.status}`)
      return await response.json()
    } catch (error) {
      createError = error
      throw error
    }
  })
  expect(await screen.findByTestId('fs-entry-alpha')).toBeInTheDocument()
  fireEvent.change(await screen.findByTestId('fs-manual-path'), { target: { value: project } })
  await waitFor(() => expect(screen.getByTestId('fs-preview-name-input')).toHaveValue('alpha'))
  await act(async () => releaseProbe())
  await waitFor(() =>
    expect(screen.getByTestId('fs-preview-path')).toHaveTextContent(realpathSync.native(root))
  )
  expect(screen.getByTestId('fs-preview-name-input')).toHaveValue('alpha')
  fireEvent.change(screen.getByTestId('fs-manual-path'), { target: { value: '' } })
  await waitFor(() =>
    expect(screen.getByTestId('fs-preview-name-input')).toHaveValue(basename(root))
  )
  fireEvent.change(screen.getByTestId('fs-preview-name-input'), { target: { value: 'My project' } })
  fireEvent.click(screen.getByRole('button', { name: 'Advanced: paste path' }))
  expect(screen.getByTestId('fs-preview-name-input')).toHaveValue('My project')
  fireEvent.click(screen.getByRole('button', { name: 'Advanced: paste path' }))
  expect(screen.getByTestId('fs-preview-name-input')).toHaveValue('My project')
  fireEvent.change(screen.getByTestId('fs-manual-path'), { target: { value: project } })
  await waitFor(() => expect(screen.getByTestId('fs-preview-name-input')).toHaveValue('alpha'))
  const button = screen.getByTestId('add-workspace-create')
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  await waitFor(async () => {
    expect(createError).toBeUndefined()
    const response = await fetch('/api/workspaces')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'alpha', path: realpathSync.native(project) }),
      ])
    )
  })
  expect(pickerRequests).toBe(0)
})

test('wide Mac client displays the directory selected by the real picker endpoint', async () => {
  clientPlatform(false)
  renderFlow('wide')
  await screen.findByTestId('confirm-workspace-dialog')
  expect(screen.getByTestId('confirm-workspace-path')).toHaveValue(project)
  expect(pickerRequests).toBe(1)
})

test('wide Windows client displays real server entries without a native picker', async () => {
  clientPlatform(true)
  renderFlow('wide')
  await screen.findByTestId('add-workspace-dialog')
  expect(await screen.findByTestId('fs-entry-alpha')).toBeInTheDocument()
  expect(screen.queryByTestId('confirm-workspace-dialog')).toBeNull()
  expect(pickerRequests).toBe(0)
})
