// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
const nativeFetch = globalThis.fetch

beforeEach(async () => {
  const server = await startTestServer()
  cleanupServer = server.close
  let cookie = ''
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    cookie = response.headers.get('set-cookie') ?? ''
  })
  const workspaceResponse = await nativeFetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alpha', path: '/tmp/hive-alpha' }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  await nativeFetch(`${server.baseUrl}/api/workspaces/${workspace.id}/tasks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ content: '- [ ] implement login\n' }),
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
})

describe('tasks flow with real server', () => {
  test('loads and saves tasks.md for the active workspace', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByLabelText('Tasks Markdown')).toBeInTheDocument()
    })

    expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [ ] implement login\n')

    fireEvent.change(screen.getByLabelText('Tasks Markdown'), {
      target: { value: '- [x] implement login\n' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Tasks' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Tasks Markdown')).toHaveValue('- [x] implement login\n')
    })
  })
})
