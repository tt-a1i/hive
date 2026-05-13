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
import { FirstRunWizard } from '../../web/src/wizard/FirstRunWizard.js'
import { useFirstRunFlag } from '../../web/src/wizard/useFirstRunFlag.js'
import { startTestServer } from '../helpers/test-server.js'

// ─── W1: useFirstRunFlag ───────────────────────────────────────────────────

test('useFirstRunFlag returns seen=false initially and seen=true after markSeen', () => {
  window.localStorage.clear()
  const { result } = renderHook(() => useFirstRunFlag())
  expect(result.current.seen).toBe(false)
  act(() => result.current.markSeen())
  expect(result.current.seen).toBe(true)
  expect(window.localStorage.getItem('hive.first-run-seen')).toBe('1')
})

test('useFirstRunFlag honors existing localStorage value', () => {
  window.localStorage.setItem('hive.first-run-seen', '1')
  const { result } = renderHook(() => useFirstRunFlag())
  expect(result.current.seen).toBe(true)
})

afterEach(() => cleanup())

// ─── W2: FirstRunWizard component ─────────────────────────────────────────

test('renders Slide 1 (Welcome) with Next button', () => {
  render(<FirstRunWizard open onClose={() => {}} onAddWorkspace={() => {}} onTryDemo={() => {}} />)
  expect(screen.getByText(/welcome to hive/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^next$/i })).toBeInTheDocument()
})

test('clicking Next advances to Slide 2', () => {
  render(<FirstRunWizard open onClose={() => {}} onAddWorkspace={() => {}} onTryDemo={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  expect(screen.getByText(/how it works/i)).toBeInTheDocument()
})

test('Skip closes the wizard from any slide', () => {
  const onClose = vi.fn()
  render(<FirstRunWizard open onClose={onClose} onAddWorkspace={() => {}} onTryDemo={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  expect(onClose).toHaveBeenCalledOnce()
})

test('Slide 3 Add Workspace button fires onAddWorkspace and closes', () => {
  const onAdd = vi.fn()
  const onClose = vi.fn()
  render(<FirstRunWizard open onClose={onClose} onAddWorkspace={onAdd} onTryDemo={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  fireEvent.click(screen.getByRole('button', { name: /add workspace/i }))
  expect(onAdd).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

test('Slide 3 Try Demo button fires onTryDemo and closes', () => {
  const onDemo = vi.fn()
  const onClose = vi.fn()
  render(<FirstRunWizard open onClose={onClose} onAddWorkspace={() => {}} onTryDemo={onDemo} />)
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
  fireEvent.click(screen.getByRole('button', { name: /try demo/i }))
  expect(onDemo).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

// ─── W3: App auto-opens wizard on first run ────────────────────────────────

const nativeFetch = globalThis.fetch
let cleanupServer: (() => Promise<void>) | undefined
let sandboxRoot = ''
const tempDirs: string[] = []

beforeEach(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-first-run-wizard-'))
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

test('wizard auto-opens when flag unset and workspaces empty', async () => {
  window.localStorage.clear()
  render(<App />)
  expect(await screen.findByRole('dialog', { name: /welcome to hive/i })).toBeInTheDocument()
})

test('wizard does not open when flag is set', async () => {
  window.localStorage.setItem('hive.first-run-seen', '1')
  render(<App />)
  await waitFor(() => expect(screen.getByTestId('welcome-pane')).toBeInTheDocument())
  expect(screen.queryByRole('dialog', { name: /welcome to hive/i })).toBeNull()
})

test('clicking Skip persists the flag and closes the wizard', async () => {
  window.localStorage.clear()
  render(<App />)
  await screen.findByRole('dialog', { name: /welcome to hive/i })
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  expect(window.localStorage.getItem('hive.first-run-seen')).toBe('1')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /welcome to hive/i })).toBeNull())
})
