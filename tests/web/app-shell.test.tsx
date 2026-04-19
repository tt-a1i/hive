// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
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

describe('app shell with real server', () => {
  test('renders hive title and empty workspace form from a real backend', async () => {
    render(<App />)

    expect(screen.getByText('Hive')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('No workspaces yet')).toBeInTheDocument()
    })

    expect(screen.getByLabelText('Workspace Name')).toBeInTheDocument()
    expect(screen.getByLabelText('Workspace Path')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Workspace' })).toBeInTheDocument()
  })
})
