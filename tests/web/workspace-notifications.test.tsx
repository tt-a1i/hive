// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transferableAbortController } from 'node:util'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import { getApiTransport, setApiTransport } from '../../web/src/api.js'
import {
  NOTIFICATION_SETTINGS_KEY,
  NotificationProvider,
} from '../../web/src/notifications/NotificationProvider.js'
import { WorkspaceNotifications } from '../../web/src/notifications/WorkspaceNotifications.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { requireAgentToken } from '../helpers/auth.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const originalTransport = getApiTransport()
let server: Awaited<ReturnType<typeof startTestServer>>
let root: string
let workspace: WorkspaceSummary
let workerId: string
let cookie: string
let completedReads = 0
let transportError: unknown

const tree = (workers: TeamListItem[]) => (
  <ToastProvider>
    <NotificationProvider>
      <WorkspaceNotifications terminalRuns={[]} workers={workers} workspace={workspace} />
      <Toaster />
    </NotificationProvider>
  </ToastProvider>
)
const currentWorkers = () => server.store.listWorkers(workspace.id)
const dispatch = () =>
  server.store.dispatchTask(workspace.id, workerId, 'Notification contract fixture', {
    fromAgentId: `${workspace.id}:orchestrator`,
    autoStartWorker: false,
    hivePort: new URL(server.baseUrl).port,
  })
const report = async (dispatchId: string) => {
  // Wait until delivery claims the responsibility; queued work cannot report.
  // This status alone does not prove that the child consumed the input.
  await expect
    .poll(
      () =>
        server.store.listDispatches(workspace.id).find((item) => item.id === dispatchId)?.status,
      { timeout: 10000 }
    )
    .toBe('submitted')
  const response = await fetch(`${server.baseUrl}/api/team/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: workspace.id,
      from_agent_id: workerId,
      token: requireAgentToken(server.store, workerId),
      dispatch_id: dispatchId,
      result: 'Verified result',
    }),
  })
  expect(response.status).toBe(202)
  expect(server.store.listDispatches(workspace.id)).toContainEqual(
    expect.objectContaining({ id: dispatchId, status: 'reported', reportText: 'Verified result' })
  )
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hive-notification-contract-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath)
  server = await startTestServer({ dataDir: join(root, 'runtime') })
  cookie = await getUiCookie(server.baseUrl)
  const headers = { 'content-type': 'application/json', cookie }
  const created = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ autostart_orchestrator: false, name: 'mco', path: workspacePath }),
  })
  expect(created.status).toBe(201)
  workspace = (await created.json()) as WorkspaceSummary
  const member = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'ember-check-23', role: 'coder' }),
  })
  expect(member.status).toBe(201)
  workerId = ((await member.json()) as { id: string }).id
  const script = join(root, 'member.cjs')
  writeFileSync(
    script,
    "process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdout.write('READY\\n')\n"
  )
  const configured = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${workerId}/config`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: process.execPath, args: [script] }),
    }
  )
  expect(configured.status).toBe(204)
  const started = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${workerId}/start`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ hive_port: new URL(server.baseUrl).port }),
    }
  )
  expect(started.status).toBe(201)

  window.localStorage.setItem(
    NOTIFICATION_SETTINGS_KEY,
    JSON.stringify({ desktop: false, sound: 'off', detail: 'brief' })
  )
  completedReads = 0
  transportError = undefined
  // Use the existing transport seam only to supply the test server's absolute
  // origin/cookie. Responses are from real HTTP routes and SQLite, never mocks.
  setApiTransport({
    ...originalTransport,
    async fetch(path, init) {
      try {
        const requestHeaders = new Headers(init?.headers)
        requestHeaders.set('cookie', cookie)
        // jsdom signals belong to a different realm than Node's real fetch.
        const controller = transferableAbortController()
        const abort = () => controller.abort()
        if (init?.signal?.aborted) abort()
        init?.signal?.addEventListener('abort', abort, { once: true })
        const response = await fetch(`${server.baseUrl}${path}`, {
          ...init,
          headers: requestHeaders,
          signal: controller.signal,
        }).finally(() => init?.signal?.removeEventListener('abort', abort))
        if (path.includes('/dispatches?')) {
          expect(response.status).toBe(200)
          await response.clone().json()
          completedReads += 1 // Synchronize on real completed snapshots, not fixed sleeps.
        }
        return response
      } catch (error) {
        transportError = error
        throw error
      }
    },
  })
})

afterEach(async () => {
  cleanup()
  setApiTransport(originalTransport)
  await server?.close()
  if (root) removeTestPath(root)
})

describe('workspace notifications', () => {
  test('seeds member and historical-report snapshots without startup or replay toasts', async () => {
    const historical = await dispatch()
    await report(historical.id)
    render(tree(currentWorkers()))
    // Initial server-clock snapshot + boundary seed + an ordinary overlapping poll.
    await waitFor(
      () => {
        if (transportError) throw transportError
        return expect(completedReads).toBeGreaterThanOrEqual(3)
      },
      { timeout: 5000 }
    )
    expect(screen.queryByTestId('toast')).toBeNull()
  }, 10000)

  test('cancel-to-idle stays quiet; a real report notifies once without requiring a worker transition', async () => {
    const cancelled = await dispatch()
    const view = render(tree(currentWorkers()))
    await waitFor(
      () => {
        if (transportError) throw transportError
        return expect(completedReads).toBeGreaterThanOrEqual(2)
      },
      { timeout: 5000 }
    )
    const beforeCancelRead = completedReads
    await act(async () => {
      await server.store.cancelTask(workspace.id, cancelled.id, {
        fromAgentId: `${workspace.id}:orchestrator`,
        reason: 'No longer required',
      })
      view.rerender(tree(currentWorkers()))
    })
    expect(server.store.listDispatches(workspace.id)).toContainEqual(
      expect.objectContaining({ id: cancelled.id, status: 'cancelled' })
    )
    await waitFor(
      () => {
        if (transportError) throw transportError
        return expect(completedReads).toBeGreaterThan(beforeCancelRead)
      },
      { timeout: 5000 }
    )
    expect(screen.queryByTestId('toast')).toBeNull()

    const completed = await dispatch()
    await report(completed.id)
    // Deliberately keep the rendered member idle: only the committed report
    // returned by the real HTTP query can cause this notification.
    await waitFor(
      () => expect(screen.getByTestId('toast')).toHaveTextContent('ember-check-23 reported'),
      { timeout: 5000 }
    )
    const reportedRead = completedReads
    await waitFor(
      () => {
        if (transportError) throw transportError
        return expect(completedReads).toBeGreaterThan(reportedRead)
      },
      { timeout: 5000 }
    )
    expect(screen.getAllByTestId('toast')).toHaveLength(1)
  }, 15000)
})
