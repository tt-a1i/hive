// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
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
let serverContext: Awaited<ReturnType<typeof startTestServer>> | undefined
let workspaceId = ''
let sleeperPresetId = ''
let uiCookie = ''

beforeEach(async () => {
  window.matchMedia =
    window.matchMedia ??
    ((query: string) =>
      ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
      }) as MediaQueryList)

  const server = await startTestServer()
  serverContext = server
  cleanupServer = server.close
  let cookie = ''
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    cookie = response.headers.get('set-cookie') ?? ''
  })
  uiCookie = cookie
  const workspaceResponse = await nativeFetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: '/tmp/hive-alpha' }),
  })
  workspaceId = ((await workspaceResponse.json()) as { id: string }).id
  const presetResponse = await nativeFetch(`${server.baseUrl}/api/settings/command-presets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      display_name: 'Sleeper',
      command: 'bash',
      args: ['-c', 'echo worker up; sleep 60'],
      env: {},
      resume_args_template: null,
      session_id_capture: null,
      yolo_args_template: null,
    }),
  })
  sleeperPresetId = ((await presetResponse.json()) as { id: string }).id
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
  workspaceId = ''
  sleeperPresetId = ''
  uiCookie = ''
})

describe('worker flow with real server', () => {
  test('Add Worker dialog creates a card with role badge + status dot', async () => {
    render(<App />)

    // Open the AddWorkerDialog via the Team Members pane "+ New Member" header button
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /New Member/ })
      expect(buttons.length).toBeGreaterThan(0)
    })
    expect(screen.getByText('Team Members')).toBeInTheDocument()
    const newWorkerButtons = screen.getAllByRole('button', { name: /New Member/ })
    fireEvent.click(newWorkerButtons[0] as HTMLElement)

    const dialog = await screen.findByRole('form', { name: 'Add team member' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Alice' } })
    // role defaults to coder; explicit select keeps the test honest
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'coder' } })
    const agentSelect = within(dialog).getByLabelText('Agent')
    await waitFor(() => {
      expect(within(agentSelect).getByRole('option', { name: 'Sleeper' })).toBeInTheDocument()
    })
    const sleeperOption = within(agentSelect).getByRole('option', { name: 'Sleeper' })
    fireEvent.change(agentSelect, { target: { value: sleeperOption.getAttribute('value') ?? '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    // Dialog closes, card appears with testid + role badge
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull()
    })

    const card = await screen.findByRole('button', { name: /^Open Alice$/ })
    expect(card).toBeInTheDocument()
    expect(within(card).getByText('Alice')).toBeInTheDocument()
    expect(within(card).getByText('Coder')).toBeInTheDocument()
    expect(within(card).getByText('idle')).toBeInTheDocument()
    const grid = screen.getByTestId('worker-grid')
    expect(within(grid).getAllByRole('button')[0]).toHaveTextContent('New Member')

    const workerRun = serverContext?.store
      .listTerminalRuns(workspaceId)
      .find((run) => run.agent_name === 'Alice')
    expect(workerRun?.run_id).toEqual(expect.any(String))

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(card)
    const modal = await screen.findByRole('dialog', { name: 'Alice detail' })
    await waitFor(() => {
      expect(document.querySelector('[id^="worker-pty-"]')).not.toBeNull()
    })
    fireEvent.click(within(modal).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Open Alice$/ })).toBeNull()
    })
    expect(serverContext?.store.listWorkers(workspaceId)).toHaveLength(0)
    expect(serverContext?.store.listTerminalRuns(workspaceId)).toHaveLength(0)
  })

  test('stopped worker can be started from the detail modal after reload', async () => {
    const response = await nativeFetch(
      `${serverContext?.baseUrl}/api/workspaces/${workspaceId}/workers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart: false,
          command_preset_id: sleeperPresetId,
          hive_port: '4010',
          name: 'Bob',
          role: 'coder',
        }),
      }
    )
    expect(response.status).toBe(201)

    render(<App />)

    const card = await screen.findByRole('button', { name: /^Open Bob$/ })
    expect(within(card).getByText('stopped')).toBeInTheDocument()
    fireEvent.click(card)

    const modal = await screen.findByRole('dialog', { name: 'Bob detail' })
    expect(within(modal).getByText(/PTY not running/)).toBeInTheDocument()
    fireEvent.click(within(modal).getAllByRole('button', { name: 'Start' })[0] as HTMLElement)

    await waitFor(() => {
      expect(document.querySelector('[id^="worker-pty-"]')).not.toBeNull()
    })
    await waitFor(() => {
      const workerRun = serverContext?.store
        .listTerminalRuns(workspaceId)
        .find((run) => run.agent_name === 'Bob')
      expect(workerRun?.run_id).toEqual(expect.any(String))
    })
  })

  test('worker cards refresh when backend pending count changes', async () => {
    const response = await nativeFetch(
      `${serverContext?.baseUrl}/api/workspaces/${workspaceId}/workers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart: false,
          command_preset_id: sleeperPresetId,
          hive_port: '4010',
          name: 'Carol',
          role: 'coder',
        }),
      }
    )
    expect(response.status).toBe(201)
    const worker = (await response.json()) as { id: string }

    render(<App />)

    await waitFor(() => {
      const card = screen.getByRole('button', { name: /^Open Carol$/ })
      // Initial card: stopped + queue=0 — only the status pill is asserted.
      // (M6-A removed the redundant "queue: N" footer; pending count surfaces
      // only when > 0 via the queue-badge.)
      expect(within(card).getByText('stopped')).toBeInTheDocument()
      expect(within(card).queryByText('1 queued')).toBeNull()
    })

    serverContext?.store.dispatchTask(workspaceId, worker.id, 'Implement refresh')

    await waitFor(
      () => {
        const card = screen.getByRole('button', { name: /^Open Carol$/ })
        // spec §3.6.4: pending_task_count is orthogonal to status. The status
        // pill stays `stopped` (PTY isn't running); the queue length surfaces
        // as a separate orange queue-badge.
        expect(within(card).getByText('stopped')).toBeInTheDocument()
        expect(within(card).getByText('1 queued')).toBeInTheDocument()
        // Sub-header: 0 working / 0 idle / 2 stopped, with 1 queued aside.
        expect(screen.getByTestId('workspace-sub-header')).toHaveTextContent('1 queued')
      },
      { timeout: 2000 }
    )
  })
})
