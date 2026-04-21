// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  await nativeFetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alpha', path: '/tmp/hive-alpha' }),
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

describe('worker flow with real server', () => {
  test('Add Worker dialog creates a card with role badge + status dot', async () => {
    render(<App />)

    // Open the AddWorkerDialog via the Workers pane "+ New Worker" header button
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /New Worker/ })
      expect(buttons.length).toBeGreaterThan(0)
    })
    const newWorkerButtons = screen.getAllByRole('button', { name: /New Worker/ })
    fireEvent.click(newWorkerButtons[0] as HTMLElement)

    const dialog = await screen.findByRole('form', { name: 'Add worker' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Alice' } })
    // role defaults to coder; explicit select keeps the test honest
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'coder' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    // Dialog closes, card appears with testid + role badge
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Add worker' })).toBeNull()
    })

    const card = await screen.findByRole('button', { name: /^Open Alice$/ })
    expect(card).toBeInTheDocument()
    expect(within(card).getByText('Alice')).toBeInTheDocument()
    expect(within(card).getByText('Coder')).toBeInTheDocument()
    expect(within(card).getByText('stopped')).toBeInTheDocument()
  })
})
