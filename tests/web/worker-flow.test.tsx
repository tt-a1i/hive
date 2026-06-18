// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
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

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {},
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))

vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {},
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

let cleanupServer: (() => Promise<void>) | undefined
const nativeFetch = globalThis.fetch
let serverContext: Awaited<ReturnType<typeof startTestServer>> | undefined
let workspaceId = ''
let sleeperPresetId = ''
let uiCookie = ''

const WORKER_FLOW_TIMEOUT_MS = 5000

const openAddWorkerDialog = async (label = 'Add team member') => {
  fireEvent.click(
    await screen.findByTestId('add-worker-trigger', {}, { timeout: WORKER_FLOW_TIMEOUT_MS })
  )
  return screen.findByRole('form', { name: label }, { timeout: WORKER_FLOW_TIMEOUT_MS })
}

const fetchThroughServer = (input: RequestInfo | URL, init?: RequestInit) => {
  const value =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const url = value.startsWith('http') ? value : `${serverContext?.baseUrl}${value}`
  const headers = new Headers(init?.headers)
  headers.set('cookie', uiCookie)
  return { headers, url }
}

const stubFetch = () => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const { headers, url } = fetchThroughServer(input, init)
    return nativeFetch(url, { ...init, headers })
  })
}

const stubFetchWithEmptyTerminalRuns = () => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const { headers, url } = fetchThroughServer(input, init)
    if (url.endsWith(`/api/ui/workspaces/${workspaceId}/runs`)) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        })
      )
    }
    return nativeFetch(url, { ...init, headers })
  })
}

beforeEach(async () => {
  window.localStorage.clear()
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
  stubFetch()
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
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

    expect(
      await screen.findByText('Team members', {}, { timeout: WORKER_FLOW_TIMEOUT_MS })
    ).toBeInTheDocument()
    const dialog = await openAddWorkerDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate random member name' }))
    const nameInput = within(dialog).getByPlaceholderText('e.g. Alice') as HTMLInputElement
    expect(nameInput.value).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Alice'), {
      target: { value: 'Alice' },
    })
    // M6-A: role is selected via card buttons (no native select). Coder card is
    // the default-active card; click is idempotent and asserts wiring.
    fireEvent.click(within(dialog).getByTestId('role-card-coder'))
    // Agent CLI is selected via radio-style buttons keyed by preset id.
    await waitFor(() => {
      expect(within(dialog).queryByTestId(`agent-radio-${sleeperPresetId}`)).toBeInTheDocument()
    })
    fireEvent.click(within(dialog).getByTestId(`agent-radio-${sleeperPresetId}`))
    fireEvent.click(within(dialog).getByTestId('add-worker-submit'))

    // Dialog closes, card appears with testid + role badge
    await waitFor(
      () => {
        expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull()
      },
      { timeout: WORKER_FLOW_TIMEOUT_MS }
    )

    const card = await screen.findByRole(
      'button',
      { name: /^Open Alice$/ },
      { timeout: WORKER_FLOW_TIMEOUT_MS }
    )
    expect(card).toBeInTheDocument()
    expect(within(card).getByText('Alice')).toBeInTheDocument()
    expect(within(card).getByText(/· Coder/)).toBeInTheDocument()
    expect(within(card).getByText('idle')).toBeInTheDocument()
    // Add Member affordance now lives only in the WorkersPane header (the
    // dashed in-grid Add Member tile was redundant and visually misleading).
    expect(screen.getByTestId('add-worker-trigger')).toHaveTextContent('Add Member')

    const workerRun = serverContext?.store
      .listTerminalRuns(workspaceId)
      .find((run) => run.agent_name === 'Alice')
    expect(workerRun?.run_id).toEqual(expect.any(String))

    // Verify clicking the card opens the worker detail modal, matching the
    // released member-window behavior, instead of moving workers into the
    // bottom terminal panel.
    fireEvent.click(card)
    const modal = await screen.findByTestId('worker-modal')
    expect(within(modal).getByTestId('worker-modal-terminal-slot')).toBeInTheDocument()
    expect(screen.queryByTestId('terminal-bottom-panel')).toBeNull()
    await waitFor(() => {
      expect(document.getElementById(`worker-pty-${workerRun?.run_id}`)).not.toBeNull()
    })
    fireEvent.click(within(modal).getByLabelText('Close worker detail'))
    await waitFor(() => {
      expect(screen.queryByTestId('worker-modal')).toBeNull()
    })

    // Delete via the card's dropdown action menu.
    const workers = serverContext?.store.listWorkers(workspaceId) ?? []
    const alice = workers.find((w) => w.name === 'Alice')
    fireEvent.click(screen.getByTestId(`worker-card-more-${alice?.id}`))
    const deleteItem = await screen.findByTestId(`worker-card-delete-${alice?.id}`)
    fireEvent.click(deleteItem)
    const confirm = await screen.findByTestId('confirm-title')
    expect(confirm).toHaveTextContent('Delete Alice?')
    fireEvent.click(screen.getByTestId('confirm-action'))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Open Alice$/ })).toBeNull()
    })
    expect(serverContext?.store.listWorkers(workspaceId)).toHaveLength(0)
    expect(
      serverContext?.store.listTerminalRuns(workspaceId).filter((run) => run.agent_name === 'Alice')
    ).toHaveLength(0)
  })

  test('Add Worker dialog shows role instructions and saves an edited prompt', async () => {
    render(<App />)

    const dialog = await openAddWorkerDialog()
    const instructions = await within(dialog).findByLabelText('Role instructions')
    expect((instructions as HTMLTextAreaElement).value).toContain('You are a Coder')
    expect((instructions as HTMLTextAreaElement).value).toContain('Report changed files')

    fireEvent.click(within(dialog).getByTestId('role-card-reviewer'))
    expect((instructions as HTMLTextAreaElement).value).toContain('You are a Reviewer')
    expect((instructions as HTMLTextAreaElement).value).toContain('blocking issues')

    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Alice'), {
      target: { value: 'ReviewLead' },
    })
    fireEvent.change(instructions, {
      target: {
        value: '你是审查型 worker。先找高风险问题，再给出最小修复建议。',
      },
    })
    expect(within(dialog).getByText(/Modified from Reviewer default/)).toBeInTheDocument()
    expect((instructions as HTMLTextAreaElement).value).toContain(
      '你是审查型 worker。先找高风险问题，再给出最小修复建议。'
    )
    await waitFor(() => {
      expect(within(dialog).queryByTestId(`agent-radio-${sleeperPresetId}`)).toBeInTheDocument()
    })
    fireEvent.click(within(dialog).getByTestId(`agent-radio-${sleeperPresetId}`))
    fireEvent.click(within(dialog).getByTestId('add-worker-submit'))

    await waitFor(
      () => {
        expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull()
      },
      { timeout: WORKER_FLOW_TIMEOUT_MS }
    )
    const worker = serverContext?.store
      .getWorkspaceSnapshot(workspaceId)
      .agents.find((agent) => agent.name === 'ReviewLead')
    expect(worker?.role).toBe('reviewer')
    expect(worker?.description).toBe('你是审查型 worker。先找高风险问题，再给出最小修复建议。')
  })

  test('Add Worker random name follows the selected Chinese language', async () => {
    render(<App />)

    await screen.findByTestId('add-worker-trigger', {}, { timeout: WORKER_FLOW_TIMEOUT_MS })
    fireEvent.click(screen.getByRole('button', { name: 'Switch language to 中文' }))
    await waitFor(() => {
      expect(screen.getByTestId('add-worker-trigger')).toHaveTextContent('添加成员')
    })

    const dialog = await openAddWorkerDialog('添加团队成员')
    const nameInput = within(dialog).getByPlaceholderText('例如 鲁班') as HTMLInputElement
    fireEvent.click(within(dialog).getByRole('button', { name: '生成随机成员名' }))

    expect(nameInput.value).toMatch(/^[\u4e00-\u9fff]+$/)
  })

  test('Add Worker dialog can run a generic full startup command without preset semantics', async () => {
    render(<App />)

    const dialog = await openAddWorkerDialog()
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Alice'), {
      target: { value: 'CustomAgent' },
    })
    await waitFor(() => {
      expect(within(dialog).queryByTestId('agent-radio-generic')).toBeInTheDocument()
    })
    fireEvent.click(within(dialog).getByTestId('agent-radio-generic'))
    fireEvent.click(within(dialog).getByText('Startup command'))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Startup command' }), {
      target: { value: 'bash -c "echo custom worker; sleep 60"' },
    })
    fireEvent.click(within(dialog).getByTestId('add-worker-submit'))

    await waitFor(
      () => {
        expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull()
      },
      { timeout: WORKER_FLOW_TIMEOUT_MS }
    )

    const worker = serverContext?.store
      .getWorkspaceSnapshot(workspaceId)
      .agents.find((agent) => agent.name === 'CustomAgent')
    expect(worker?.id).toEqual(expect.any(String))
    expect(serverContext?.store.peekAgentLaunchConfig(workspaceId, worker?.id ?? '')).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining(['bash -c "echo custom worker; sleep 60"']),
        commandPresetId: null,
        interactiveCommand: 'bash',
        presetAugmentationDisabled: true,
        sessionIdCapture: null,
      })
    )
  })

  test('Add Worker dialog keeps selected CLI semantics for startup aliases', async () => {
    render(<App />)

    const dialog = await openAddWorkerDialog()
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Alice'), {
      target: { value: 'ClaudeAlias' },
    })
    await waitFor(() => {
      expect(within(dialog).queryByTestId('agent-radio-claude')).toBeInTheDocument()
    })
    fireEvent.click(within(dialog).getByTestId('agent-radio-claude'))
    fireEvent.click(within(dialog).getByText('Startup command'))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Startup command' }), {
      target: { value: 'ccs --continue' },
    })
    fireEvent.click(within(dialog).getByTestId('add-worker-submit'))

    await waitFor(
      () => {
        expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull()
      },
      { timeout: WORKER_FLOW_TIMEOUT_MS }
    )

    const worker = serverContext?.store
      .getWorkspaceSnapshot(workspaceId)
      .agents.find((agent) => agent.name === 'ClaudeAlias')
    expect(worker?.id).toEqual(expect.any(String))
    expect(serverContext?.store.peekAgentLaunchConfig(workspaceId, worker?.id ?? '')).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining(['ccs --continue']),
        commandPresetId: null,
        interactiveCommand: 'claude',
        presetAugmentationDisabled: true,
        sessionIdCapture: expect.objectContaining({ source: 'claude_project_jsonl_dir' }),
      })
    )
  })

  test('new member opens with its PTY before terminal-runs polling catches up', async () => {
    stubFetchWithEmptyTerminalRuns()
    render(<App />)

    const dialog = await openAddWorkerDialog()
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Alice'), {
      target: { value: 'Immediate' },
    })
    await waitFor(() => {
      expect(within(dialog).queryByTestId(`agent-radio-${sleeperPresetId}`)).toBeInTheDocument()
    })
    fireEvent.click(within(dialog).getByTestId(`agent-radio-${sleeperPresetId}`))
    fireEvent.click(within(dialog).getByTestId('add-worker-submit'))

    const card = await screen.findByRole(
      'button',
      { name: /^Open Immediate$/ },
      { timeout: WORKER_FLOW_TIMEOUT_MS }
    )
    fireEvent.click(card)

    const modal = await screen.findByTestId('worker-modal')
    expect(within(modal).getByTestId('worker-modal-terminal-slot')).toBeInTheDocument()
    expect(screen.queryByTestId('terminal-bottom-panel')).toBeNull()
    await waitFor(() => {
      expect(document.querySelector('[id^="worker-pty-"]')).not.toBeNull()
    })
  })

  test('stopped worker can be started from the worker detail modal after reload', async () => {
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

    const modal = await screen.findByTestId('worker-modal')
    expect(screen.queryByTestId('terminal-bottom-panel')).toBeNull()
    fireEvent.click(within(modal).getByTestId('worker-start-empty'))

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
})
