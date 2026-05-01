// @vitest-environment jsdom

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
const nativeFetch = globalThis.fetch
let workspacePath = ''
let workspaceId = ''
let baseUrl = ''
let uiCookie = ''
const tempDirs: string[] = []

class ForwardedWebSocket {
  readonly OPEN = 1
  private socket: WebSocket
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null

  constructor(url: string) {
    const resolvedPath = new URL(url, 'http://localhost').pathname
    const resolvedUrl = `${baseUrl.replace('http://', 'ws://')}${resolvedPath}`
    this.socket = new WebSocket(resolvedUrl, { headers: { cookie: uiCookie } })
    this.socket.on('open', () => this.onopen?.())
    this.socket.on('message', (data) => this.onmessage?.({ data: data.toString() }))
    this.socket.on('close', () => this.onclose?.())
    this.socket.on('error', () => this.onerror?.())
  }

  close() {
    this.socket.close()
  }

  get readyState() {
    return this.socket.readyState
  }

  send(payload: string) {
    this.socket.send(payload)
  }
}

beforeEach(async () => {
  const server = await startTestServer()
  cleanupServer = server.close
  baseUrl = server.baseUrl
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    uiCookie = response.headers.get('set-cookie') ?? ''
  })
  workspacePath = mkdtempSync(join(tmpdir(), 'hive-tasks-flow-'))
  tempDirs.push(workspacePath)
  const workspaceResponse = await nativeFetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({
      name: 'Alpha',
      path: workspacePath,
      autostart_orchestrator: false,
    }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  workspaceId = workspace.id
  await nativeFetch(`${server.baseUrl}/api/workspaces/${workspace.id}/tasks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ content: '- [ ] implement login\n' }),
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${server.baseUrl}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', uiCookie)
    return nativeFetch(url, { ...init, headers })
  })
  vi.stubGlobal('WebSocket', ForwardedWebSocket as never)
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const openTaskGraph = async () => {
  const drawer = await screen.findByTestId('task-graph-drawer')
  if (drawer.getAttribute('aria-hidden') === 'true') {
    fireEvent.click(screen.getByRole('button', { name: 'Toggle blueprint' }))
  }
  await waitFor(() => {
    expect(drawer).toHaveAttribute('aria-hidden', 'false')
  })
  return drawer
}

const enterRawEditor = async (expectedInitialValue: string) => {
  await openTaskGraph()
  // Wait until tasks content is loaded (checkbox rendered means parseTaskMarkdown ran)
  await screen.findByTestId('task-checkbox-0')
  fireEvent.click(screen.getByRole('button', { name: 'edit raw' }))
  await waitFor(() => {
    expect(screen.getByLabelText('Tasks Markdown')).toHaveValue(expectedInitialValue)
  })
}

describe('tasks flow driven from the Task Graph drawer', () => {
  test('task graph starts closed and opens to a readable summary and nested task tree', async () => {
    await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({
        content: '- [ ] implement login @Alice\n  - [x] wire submit\n- [x] review docs @Bob\n',
      }),
    })

    render(<App />)

    const drawer = await screen.findByTestId('task-graph-drawer')
    expect(drawer).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle blueprint' }))

    await waitFor(() => {
      expect(drawer).toHaveAttribute('aria-hidden', 'false')
    })

    const summary = await within(drawer).findByTestId('task-graph-summary')
    expect(summary).toHaveTextContent('2/3')
    expect(summary).toHaveTextContent('67%')
    expect(within(drawer).getByTestId('task-progress-bar')).toHaveAttribute('aria-valuenow', '67')
    expect(within(drawer).getByText('@Alice')).toBeInTheDocument()
    expect(within(drawer).getByText('@Bob')).toBeInTheDocument()
    expect(within(drawer).getByTestId('task-line-1')).toHaveTextContent('wire submit')
  })

  test('toggling a checkbox persists to tasks.md', async () => {
    render(<App />)
    await openTaskGraph()

    const checkbox = await screen.findByTestId('task-checkbox-0')
    expect(checkbox).not.toBeChecked()

    fireEvent.click(checkbox)

    await waitFor(async () => {
      const saved = await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
        headers: { cookie: uiCookie },
      })
      await expect(saved.json()).resolves.toEqual({ content: '- [x] implement login\n' })
    })

    await waitFor(() => {
      expect(screen.getByTestId('task-checkbox-0')).toBeChecked()
    })
  })

  test('raw editor save persists edits to tasks.md', async () => {
    render(<App />)
    await enterRawEditor('- [ ] implement login\n')

    fireEvent.change(screen.getByLabelText('Tasks Markdown'), {
      target: { value: '- [x] implement login\n' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Tasks' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [x] implement login\n')
    })
    const savedResponse = await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
      headers: { cookie: uiCookie },
    })
    await expect(savedResponse.json()).resolves.toEqual({ content: '- [x] implement login\n' })
  })

  test('raw editor shows conflict banner when tasks.md changes externally during dirty edit', async () => {
    render(<App />)
    await enterRawEditor('- [ ] implement login\n')

    fireEvent.change(screen.getByLabelText('Tasks Markdown'), {
      target: { value: '- [ ] local draft\n' },
    })
    writeFileSync(join(workspacePath, 'tasks.md'), '- [x] external change\n', 'utf8')

    await waitFor(() => {
      expect(screen.getByText('文件已在外部变化')).toBeInTheDocument()
      expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [ ] local draft\n')
      expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Keep Local' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

    await waitFor(() => {
      expect(screen.queryByText('文件已在外部变化')).toBeNull()
      expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [x] external change\n')
    })
  })

  test('auto-updates tasks content without conflict when editor is clean', async () => {
    render(<App />)
    await enterRawEditor('- [ ] implement login\n')

    writeFileSync(join(workspacePath, 'tasks.md'), '- [x] auto sync\n', 'utf8')

    await waitFor(() => {
      expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [x] auto sync\n')
      expect(screen.queryByText('文件已在外部变化')).toBeNull()
    })
  })
})
