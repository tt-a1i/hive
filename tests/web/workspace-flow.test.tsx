// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

let cleanupServer: (() => Promise<void>) | undefined
let serverContext: Awaited<ReturnType<typeof startTestServer>> | undefined
let sandboxRoot = ''
const nativeFetch = globalThis.fetch
const tempDirs: string[] = []

beforeEach(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-fs-sandbox-'))
  mkdirSync(join(sandboxRoot, 'alpha-project'), { recursive: true })
  tempDirs.push(sandboxRoot)
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot
  // Short-circuit the native folder picker so the test doesn't actually spawn
  // osascript/zenity. The value mimics what the OS dialog would return.
  process.env.HIVE_MOCK_PICK_FOLDER = join(sandboxRoot, 'alpha-project')
  // Drive autostart with a deterministic dummy CLI instead of `claude` so the
  // test does not depend on the real binary being on PATH and so the running
  // state is observable (the bash sleep keeps the PTY alive past the
  // assertions).
  process.env.HIVE_ORCHESTRATOR_COMMAND = 'bash'
  process.env.HIVE_ORCHESTRATOR_ARGS_JSON = JSON.stringify(['-c', 'echo queen up; sleep 60'])

  const server = await startTestServer()
  serverContext = server
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
  serverContext = undefined
  delete process.env.HIVE_FS_BROWSE_ROOT
  delete process.env.HIVE_MOCK_PICK_FOLDER
  delete process.env.HIVE_ORCHESTRATOR_COMMAND
  delete process.env.HIVE_ORCHESTRATOR_ARGS_JSON
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('workspace flow with real server', () => {
  test('Add Workspace native-picker flow: compact confirm → create → sidebar + sub-header', async () => {
    render(<App />)

    // Empty-state triggers pick-folder → mock returns the sandbox dir → compact confirm opens.
    const confirm = await screen.findByTestId('confirm-workspace-dialog')
    expect(within(confirm).getByTestId('confirm-workspace-path')).toHaveValue(
      join(sandboxRoot, 'alpha-project')
    )
    fireEvent.change(within(confirm).getByTestId('confirm-workspace-name'), {
      target: { value: 'Alpha' },
    })
    fireEvent.click(within(confirm).getByTestId('confirm-workspace-create'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-current', 'true')
    })

    // Workspace name + path live in the sidebar (workspace row); the canvas
    // sub-header was removed in M6-A polish. Assert the orchestrator slot
    // mounted as the canonical "workspace canvas is loaded" signal.
    expect(screen.getByTestId('orchestrator-terminal-slot')).toBeInTheDocument()
    // After autostart the pane should land in the running state — PTY slot
    // mounted, idle/failed bodies absent. Stop/Restart actions are no longer
    // surfaced inline (M6-B palette will own them); the only running-state
    // signal is the data-pty-slot element. Polling is 500ms; allow time.
    await waitFor(
      () => {
        expect(document.querySelector('[data-pty-slot="orchestrator"]')).not.toBeNull()
      },
      { timeout: 3000 }
    )
    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()
    // 0 workers in a fresh workspace → EmptyState (no worker-grid until ≥1).
    expect(screen.getByTestId('add-worker-empty')).toBeInTheDocument()
    expect(screen.getByTestId('task-graph-drawer')).toBeInTheDocument()
  })

  test('existing workspace auto-starts Queen without exposing a manual Start Queen CTA', async () => {
    const existingPath = join(sandboxRoot, 'existing-project')
    mkdirSync(existingPath, { recursive: true })
    serverContext?.store.createWorkspace(existingPath, 'Existing')

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Existing' })).toHaveAttribute(
        'aria-current',
        'true'
      )
    })

    expect(screen.queryByTestId('orchestrator-start')).toBeNull()
    expect(screen.queryByText('Queen is offline')).toBeNull()

    await waitFor(
      () => {
        expect(document.querySelector('[data-pty-slot="orchestrator"]')).not.toBeNull()
      },
      { timeout: 3000 }
    )
    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()
  })
})
