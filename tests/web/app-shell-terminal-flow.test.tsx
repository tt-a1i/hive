// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TerminalRunSummary } from '../../web/src/api.js'
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

const nativeFetch = globalThis.fetch
const tempDirs: string[] = []

let cleanupServer: (() => Promise<void>) | undefined
let baseUrl = ''
let cookie = ''
let delayShellDeletes = false
let delayShellStarts = false
let releaseDelayedDelete: (() => void) | undefined
let releaseDelayedShellStart: (() => void) | undefined
let shellStarts: TerminalRunSummary[] = []
let workspacePath = ''

const createWorkspace = async (name = 'Alpha', path = workspacePath) => {
  const response = await nativeFetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      autostart_orchestrator: false,
      name,
      path,
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string; name: string; path: string }
}

const fetchThroughServer = async (input: RequestInfo | URL, init?: RequestInit) => {
  const value =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const url = value.startsWith('http') ? value : `${baseUrl}${value}`
  const parsed = new URL(url)
  const method = init?.method ?? 'GET'
  const headers = new Headers(init?.headers)
  headers.set('cookie', cookie)

  const forward = async () => {
    const response = await nativeFetch(url, { ...init, headers })
    if (method === 'POST' && parsed.pathname.endsWith('/shell/start')) {
      shellStarts.push((await response.clone().json()) as TerminalRunSummary)
    }
    return response
  }

  if (delayShellStarts && method === 'POST' && parsed.pathname.endsWith('/shell/start')) {
    return new Promise<Response>((resolve, reject) => {
      releaseDelayedShellStart = () => {
        forward().then(resolve, reject)
      }
    })
  }

  if (
    delayShellDeletes &&
    method === 'DELETE' &&
    /\/api\/workspaces\/[^/]+\/shell\//.test(parsed.pathname)
  ) {
    return new Promise<Response>((resolve, reject) => {
      releaseDelayedDelete = () => {
        forward().then(resolve, reject)
      }
    })
  }

  return forward()
}

beforeEach(async () => {
  window.localStorage?.clear?.()
  window.localStorage.setItem('hive.first-run-seen', '1')
  workspacePath = mkdtempSync(join(tmpdir(), 'hive-app-shell-terminal-flow-'))
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(workspacePath)
  process.env.HIVE_FS_BROWSE_ROOT = workspacePath

  const server = await startTestServer({ pickFolderPath: workspacePath })
  cleanupServer = server.close
  baseUrl = server.baseUrl
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    cookie = response.headers.get('set-cookie') ?? ''
  })
  await createWorkspace()

  delayShellDeletes = false
  delayShellStarts = false
  releaseDelayedDelete = undefined
  releaseDelayedShellStart = undefined
  shellStarts = []
  vi.stubGlobal('fetch', fetchThroughServer)
  vi.stubGlobal(
    'WebSocket',
    class {
      readonly OPEN = 1
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      readyState = 3
      close() {}
      send() {}
    } as never
  )
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
  delete process.env.HIVE_FS_BROWSE_ROOT
  cookie = ''
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const waitForShellSlot = async (runId: string) => {
  await waitFor(() => {
    expect(screen.getByTestId(`terminal-panel-slot-shell-${runId}`)).toBeInTheDocument()
  })
}

const getWorkspaceRow = async (name: string) => {
  let row: HTMLElement | undefined
  await waitFor(() => {
    row = screen
      .getAllByRole('button', { name })
      .find((button) => button.classList.contains('ws-row'))
    expect(row).toBeDefined()
  })
  return row as HTMLElement
}

describe('app shell terminal flow with real server', () => {
  test('starts an additional shell immediately even when the shell agent id already exists', async () => {
    render(<App />)

    fireEvent.click(await screen.findByTestId('open-workspace-shell'))
    await waitFor(() => expect(shellStarts).toHaveLength(1))
    expect(shellStarts[0]?.agent_name).toBe('Shell')
    await waitForShellSlot(shellStarts[0]?.run_id ?? '')

    fireEvent.click(screen.getByTestId('terminal-tab-new-shell'))
    await waitFor(() => expect(shellStarts).toHaveLength(2))

    expect(shellStarts[1]?.agent_name).toBe('Shell')
    await waitForShellSlot(shellStarts[1]?.run_id ?? '')
  }, 10000)

  test('waits for the close request before reopening the last shell', async () => {
    delayShellDeletes = true
    render(<App />)

    fireEvent.click(await screen.findByTestId('open-workspace-shell'))
    await waitFor(() => expect(shellStarts).toHaveLength(1))
    const firstRunId = shellStarts[0]?.run_id ?? ''
    expect(shellStarts[0]?.agent_name).toBe('Shell')
    await waitForShellSlot(firstRunId)

    fireEvent.click(screen.getByTestId(`terminal-tab-close-shell:${firstRunId}`))
    await waitFor(() => expect(releaseDelayedDelete).toBeDefined())
    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    await new Promise((resolve) => window.setTimeout(resolve, 50))
    expect(shellStarts).toHaveLength(1)

    releaseDelayedDelete?.()
    await waitFor(() => expect(shellStarts).toHaveLength(2))

    expect(shellStarts[1]?.agent_name).toBe('Shell')
    expect(shellStarts[1]?.run_id).not.toBe(firstRunId)
    await waitForShellSlot(shellStarts[1]?.run_id ?? '')
  }, 10000)

  test('waits for a closing shell before the bottom-panel plus starts another shell', async () => {
    delayShellDeletes = true
    render(<App />)

    fireEvent.click(await screen.findByTestId('open-workspace-shell'))
    await waitFor(() => expect(shellStarts).toHaveLength(1))
    await waitForShellSlot(shellStarts[0]?.run_id ?? '')

    fireEvent.click(screen.getByTestId('terminal-tab-new-shell'))
    await waitFor(() => expect(shellStarts).toHaveLength(2))
    const firstRunId = shellStarts[0]?.run_id ?? ''
    const secondRunId = shellStarts[1]?.run_id ?? ''
    expect(shellStarts.map((run) => run.agent_name)).toEqual(['Shell', 'Shell'])
    await waitForShellSlot(secondRunId)

    fireEvent.click(screen.getByTestId(`terminal-tab-close-shell:${firstRunId}`))
    await waitFor(() => expect(releaseDelayedDelete).toBeDefined())
    fireEvent.click(screen.getByTestId('terminal-tab-new-shell'))

    await new Promise((resolve) => window.setTimeout(resolve, 50))
    expect(shellStarts).toHaveLength(2)

    releaseDelayedDelete?.()
    await waitFor(() => expect(shellStarts).toHaveLength(3))

    expect(shellStarts[2]?.agent_name).toBe('Shell')
    expect(shellStarts[2]?.run_id).not.toBe(firstRunId)
    expect(shellStarts[2]?.run_id).not.toBe(secondRunId)
    await waitForShellSlot(shellStarts[2]?.run_id ?? '')
  }, 10000)

  test('keeps a late shell start response out of the workspace selected afterward', async () => {
    const betaPath = mkdtempSync(join(tmpdir(), 'hive-app-shell-terminal-flow-beta-'))
    mkdirSync(betaPath, { recursive: true })
    tempDirs.push(betaPath)
    const beta = await createWorkspace('Beta', betaPath)
    delayShellStarts = true

    render(<App />)

    fireEvent.click(await screen.findByTestId('open-workspace-shell'))
    await waitFor(() => expect(releaseDelayedShellStart).toBeDefined())

    fireEvent.click(await getWorkspaceRow('Beta'))
    await waitFor(() => {
      expect(
        screen
          .getAllByRole('button', { name: 'Beta' })
          .find((button) => button.classList.contains('ws-row'))
      ).toHaveAttribute('aria-current', 'true')
    })

    releaseDelayedShellStart?.()
    await waitFor(() => expect(shellStarts).toHaveLength(1))
    expect(shellStarts[0]?.agent_id).not.toBe(`${beta.id}:shell`)
    expect(screen.queryByTestId(`terminal-panel-slot-shell-${shellStarts[0]?.run_id}`)).toBeNull()

    delayShellStarts = false
    fireEvent.click(screen.getByTestId('open-workspace-shell'))
    await waitFor(() => expect(shellStarts).toHaveLength(2))

    expect(shellStarts[1]?.agent_id).toBe(`${beta.id}:shell`)
    await waitForShellSlot(shellStarts[1]?.run_id ?? '')
  }, 10000)
})
