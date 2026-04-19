// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
})

describe('worker flow with real server', () => {
  test('can create a worker for the active workspace', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('/tmp/hive-alpha')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('Worker Name'), {
      target: { value: 'Alice' },
    })
    fireEvent.change(screen.getByLabelText('Worker Role'), {
      target: { value: 'coder' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add Worker' }))

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument()
      expect(screen.getByText('coder')).toBeInTheDocument()
      expect(screen.getByText('idle')).toBeInTheDocument()
    })
  })
})
