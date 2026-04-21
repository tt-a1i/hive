// @vitest-environment jsdom

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
const nativeFetch = globalThis.fetch
const tempDirs: string[] = []

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
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('workspace create initial state', () => {
  test('newly created workspace immediately shows the Linear workspace view with empty drawer', async () => {
    render(<App />)
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-workspace-create-initial-'))
    tempDirs.push(workspacePath)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Workspace' })).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('Workspace Name'), { target: { value: 'Alpha' } })
    fireEvent.change(screen.getByLabelText('Workspace Path'), { target: { value: workspacePath } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Workspace' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-current', 'true')
    })

    const subHeader = screen.getByTestId('workspace-sub-header')
    expect(within(subHeader).getByText(workspacePath)).toBeInTheDocument()

    // Drawer shows empty-state copy instead of a checkbox list
    const drawer = screen.getByTestId('task-graph-drawer')
    expect(within(drawer).queryByTestId('task-graph-list')).toBeNull()
    expect(within(drawer).getByText(/没有任务条目/)).toBeInTheDocument()
  })
})
