// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

describe('app shell with real server', () => {
  test('renders Linear dark shell and empty workspace form against real backend', async () => {
    render(<App />)

    const banner = screen.getByRole('banner')
    expect(banner).toHaveClass('h-11')
    expect(banner.textContent ?? '').toContain('Hive')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Workspace' })).toBeInTheDocument()
    })

    expect(screen.getByLabelText('Workspace Name')).toHaveValue('')
    expect(screen.getByLabelText('Workspace Path')).toHaveValue('')

    const sidebar = screen.getByRole('complementary', { name: 'Workspace sidebar' })
    expect(sidebar).toHaveClass('w-56')
    expect(sidebar.closest('.h-screen')).toBeInTheDocument()

    expect(screen.getByRole('contentinfo')).toHaveClass('h-6')
  })
})
