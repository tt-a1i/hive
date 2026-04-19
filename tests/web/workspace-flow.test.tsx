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

describe('workspace flow with real server', () => {
  test('can create a workspace from the empty state', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Workspace' })).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('Workspace Name'), {
      target: { value: 'Alpha' },
    })
    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/tmp/hive-alpha' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Workspace' }))

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
      expect(screen.getByText('/tmp/hive-alpha')).toBeInTheDocument()
      expect(screen.getByText('Orchestrator')).toBeInTheDocument()
      expect(screen.getByLabelText('Tasks Markdown')).toBeInTheDocument()
    })
  })
})
