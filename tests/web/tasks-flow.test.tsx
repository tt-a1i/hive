// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Todo' }))
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
  fireEvent.click(screen.getByRole('button', { name: 'View source' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Todo' }))

    await waitFor(() => {
      expect(drawer).toHaveAttribute('aria-hidden', 'false')
    })

    const summary = await within(drawer).findByTestId('task-graph-summary')
    expect(summary).toHaveTextContent('2 / 3')
    expect(summary).toHaveTextContent('67%')
    expect(within(drawer).getByTestId('task-progress-bar')).toHaveAttribute('aria-valuenow', '67')
    // Owner mentions now render with an AtSign icon + plain name, so match
    // on the name text only (no leading "@" in the DOM).
    expect(within(drawer).getByText('Alice')).toBeInTheDocument()
    expect(within(drawer).getByTestId('task-line-1')).toHaveTextContent('wire submit')
    // Completed cohort ≤3 auto-expands so the just-checked task stays visible
    // (the user doesn't have to hunt for it). Bob lives in that section.
    expect(within(drawer).getByText('Bob')).toBeInTheDocument()
  })

  test('toggling a checkbox persists to .hive/tasks.md', async () => {
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

    // After toggle, the task moves into the "completed" section, which
    // auto-expands when the cohort size is ≤3 — so the checkbox stays in
    // the DOM without an extra disclosure click.
    await waitFor(() => {
      expect(screen.getByTestId('task-completed-toggle')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByTestId('task-checkbox-0')).toBeChecked()
    })
  })

  test('raw editor save persists edits to .hive/tasks.md', async () => {
    render(<App />)
    await enterRawEditor('- [ ] implement login\n')

    fireEvent.change(screen.getByLabelText('Tasks Markdown'), {
      target: { value: '- [x] implement login\n' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save tasks' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [x] implement login\n')
    })
    const savedResponse = await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
      headers: { cookie: uiCookie },
    })
    await expect(savedResponse.json()).resolves.toEqual({ content: '- [x] implement login\n' })
  })

  test('raw editor shows conflict banner when .hive/tasks.md changes externally during dirty edit', async () => {
    render(<App />)
    await enterRawEditor('- [ ] implement login\n')

    fireEvent.change(screen.getByLabelText('Tasks Markdown'), {
      target: { value: '- [ ] local draft\n' },
    })
    mkdirSync(join(workspacePath, '.hive'), { recursive: true })
    writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [x] external change\n', 'utf8')

    await waitFor(() => {
      expect(screen.getByText('File changed externally')).toBeInTheDocument()
      expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [ ] local draft\n')
      expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Keep local' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

    await waitFor(() => {
      expect(screen.queryByText('File changed externally')).toBeNull()
      expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [x] external change\n')
    })
  })

  test('auto-updates tasks content without conflict when editor is clean', async () => {
    render(<App />)
    await enterRawEditor('- [ ] implement login\n')

    mkdirSync(join(workspacePath, '.hive'), { recursive: true })
    writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [x] auto sync\n', 'utf8')

    await waitFor(() => {
      expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [x] auto sync\n')
      expect(screen.queryByText('File changed externally')).toBeNull()
    })
  })

  test('inline edit rewrites the task text and persists to .hive/tasks.md', async () => {
    render(<App />)
    await openTaskGraph()
    await screen.findByTestId('task-checkbox-0')

    fireEvent.click(screen.getByTestId('task-edit-0'))
    const input = await screen.findByTestId('task-inline-input')
    fireEvent.change(input, { target: { value: 'implement SSO' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(async () => {
      const saved = await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
        headers: { cookie: uiCookie },
      })
      await expect(saved.json()).resolves.toEqual({ content: '- [ ] implement SSO\n' })
    })
  })

  test('delete removes the task line from .hive/tasks.md', async () => {
    await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({
        content: '- [ ] keep this one\n- [ ] delete this one\n',
      }),
    })

    render(<App />)
    await openTaskGraph()
    await screen.findByTestId('task-checkbox-0')
    await screen.findByTestId('task-checkbox-1')

    fireEvent.click(screen.getByTestId('task-delete-1'))

    await waitFor(async () => {
      const saved = await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
        headers: { cookie: uiCookie },
      })
      await expect(saved.json()).resolves.toEqual({ content: '- [ ] keep this one\n' })
    })
  })

  test('add subtask inserts a nested task under the parent', async () => {
    render(<App />)
    await openTaskGraph()
    await screen.findByTestId('task-checkbox-0')

    fireEvent.click(screen.getByTestId('task-add-subtask-0'))
    const input = await screen.findByTestId('task-inline-input')
    fireEvent.change(input, { target: { value: 'wire login form' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(async () => {
      const saved = await nativeFetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
        headers: { cookie: uiCookie },
      })
      await expect(saved.json()).resolves.toEqual({
        content: '- [ ] implement login\n  - [ ] wire login form\n',
      })
    })
  })
})
