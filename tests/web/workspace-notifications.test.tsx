// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import {
  NOTIFICATION_SETTINGS_KEY,
  NotificationProvider,
} from '../../web/src/notifications/NotificationProvider.js'
import { WorkspaceNotifications } from '../../web/src/notifications/WorkspaceNotifications.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'

const workspace: WorkspaceSummary = {
  id: 'workspace-1',
  name: 'mco',
  path: '/tmp/mco',
}
let storage = new Map<string, string>()

const installLocalStorage = () => {
  storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  })
}

const member = (overrides: Partial<TeamListItem>): TeamListItem => ({
  id: 'member-1',
  name: 'ember-check-23',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'idle',
  ...overrides,
})

const renderNotifications = (workers: TeamListItem[]) =>
  render(
    <ToastProvider>
      <NotificationProvider>
        <WorkspaceNotifications terminalRuns={[]} workers={workers} workspace={workspace} />
        <Toaster />
      </NotificationProvider>
    </ToastProvider>
  )

beforeEach(() => {
  installLocalStorage()
  window.localStorage.removeItem(NOTIFICATION_SETTINGS_KEY)
})

afterEach(() => {
  cleanup()
})

describe('workspace notifications', () => {
  test('seeds initial member state without emitting startup toasts', () => {
    renderNotifications([member({ status: 'working', pendingTaskCount: 1 })])

    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('notifies when a working member reports back to idle', () => {
    const view = renderNotifications([member({ status: 'working', pendingTaskCount: 1 })])

    view.rerender(
      <ToastProvider>
        <NotificationProvider>
          <WorkspaceNotifications
            terminalRuns={[]}
            workers={[member({ status: 'idle', pendingTaskCount: 0 })]}
            workspace={workspace}
          />
          <Toaster />
        </NotificationProvider>
      </ToastProvider>
    )

    expect(screen.getByTestId('toast')).toHaveTextContent('ember-check-23 reported')
  })
})
