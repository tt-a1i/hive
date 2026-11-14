// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import { ActionCenterTopbarButton } from '../../web/src/action-center/ActionCenterStrip.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { MainLayout } from '../../web/src/layout/MainLayout.js'
import type { WorkspaceSidebarResize } from '../../web/src/layout/useWorkspaceSidebarResize.js'
import { LayoutModeProvider } from '../../web/src/mobile/layout-mode.js'
import { NotificationProvider } from '../../web/src/notifications/NotificationProvider.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { WorkspaceDetail } from '../../web/src/WorkspaceDetail.js'

const workspace: WorkspaceSummary = { id: 'ws-1', name: 'Alpha', path: '/tmp/alpha' }
const worker: TeamListItem = {
  id: 'worker-1',
  name: 'Alice',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'idle',
}

const versionResponse = {
  can_run_hive_update: false,
  current_version: '0.0.0-test',
  install_hint: 'pnpm install',
  install_source: 'pnpm-global',
  latest_version: '0.0.0-test',
  package_name: '@tt-a1i/hive',
  release_url: '',
  update_note: 'Hive appears to be installed through pnpm.',
  update_available: false,
}

const actionCenterResponse = {
  attention: [],
  generated_at: Date.now(),
  recent_activity: [],
  summary: {
    idle_workers: 0,
    open_dispatches: 1,
    recent_reports: 0,
    stopped_with_queue: 0,
    stopped_workers: 0,
    total_workers: 1,
    waiting_reports: 0,
    working_workers: 1,
  },
  workers: [
    {
      current_dispatch: null,
      id: worker.id,
      latest_report: null,
      name: worker.name,
      pending_task_count: 0,
      role: worker.role,
      status: 'working',
      terminal_hint: 'Working on a UI fix',
    },
  ],
  workspace_id: workspace.id,
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = new URL(value, 'http://127.0.0.1')
      if (url.pathname === '/api/version') {
        return Promise.resolve(
          new Response(JSON.stringify(versionResponse), {
            headers: { 'content-type': 'application/json' },
          })
        )
      }
      if (url.pathname === `/api/ui/workspaces/${workspace.id}/action-center`) {
        return Promise.resolve(
          new Response(JSON.stringify(actionCenterResponse), {
            headers: { 'content-type': 'application/json' },
          })
        )
      }
      if (url.pathname === `/api/workspaces/${workspace.id}/recap`) {
        return Promise.resolve(
          new Response(JSON.stringify({ generated_at: Date.now(), markdown: '# Recap\n' }), {
            headers: { 'content-type': 'application/json' },
          })
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'unexpected request' }), { status: 404 })
      )
    })
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sidebarResize: WorkspaceSidebarResize = {
  beginResize: vi.fn(),
  collapsed: true,
  onResizeKeyDown: vi.fn(),
  resizing: false,
  toggleCollapsed: vi.fn(),
  width: 56,
}

const renderProviders = (children: ReactNode) =>
  render(
    <LayoutModeProvider value={{ mode: 'wide' }}>
      <I18nProvider>
        <ToastProvider>
          <NotificationProvider>{children}</NotificationProvider>
        </ToastProvider>
      </I18nProvider>
    </LayoutModeProvider>
  )

const workspaceDetailProps = {
  onCreateWorker: vi.fn(),
  onDeleteWorker: vi.fn(),
  onDeleteWorkspace: vi.fn(),
  onOrchestratorResult: vi.fn(),
  onRequestAddWorkspace: vi.fn(),
  onRestartWorker: vi.fn(),
  onStartWorker: vi.fn(),
  onStopWorker: vi.fn(),
  onUpdateWorkerAvatar: vi.fn(async () => ({ error: null })),
  orchestratorAutostartError: null,
  terminalRuns: [],
  workers: [worker],
  workspace,
}

const ControlledTopbarAndWorkspace = () => {
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null)

  return (
    <>
      <ActionCenterTopbarButton workspaceId={workspace.id} onOpenWorker={setActiveWorkerId} />
      <WorkspaceDetail
        {...workspaceDetailProps}
        activeWorkerId={activeWorkerId}
        onActiveWorkerChange={setActiveWorkerId}
        showInlineActionCenter={false}
      />
    </>
  )
}

describe('desktop Action Center topbar placement', () => {
  test('renders Action Center in the topbar after the workspace action', () => {
    renderProviders(
      <MainLayout
        sidebar={<div data-testid="sidebar-content">sidebar</div>}
        sidebarResize={sidebarResize}
        topbarActions={
          <>
            <button type="button" data-testid="topbar-open-probe">
              Open
            </button>
            <ActionCenterTopbarButton workspaceId={workspace.id} />
          </>
        }
      >
        <div data-testid="workspace-content">workspace</div>
      </MainLayout>
    )

    const open = screen.getByTestId('topbar-open-probe')
    const actionCenter = screen.getByTestId('topbar-action-center')
    expect(actionCenter.closest('header')).toBe(screen.getByRole('banner'))
    expect(open.compareDocumentPosition(actionCenter) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0
    )
    expect(screen.getByRole('complementary', { name: 'Workspace sidebar' })).not.toContainElement(
      actionCenter
    )
  })

  test('topbar Action Center worker selection opens the shared worker detail modal', async () => {
    renderProviders(<ControlledTopbarAndWorkspace />)

    expect(screen.queryByTestId('action-center-strip')).toBeNull()
    fireEvent.click(screen.getByTestId('topbar-action-center'))
    expect(await screen.findByTestId('action-center-drawer')).toBeInTheDocument()
    expect(screen.queryByTestId('action-center-popover')).toBeNull()
    fireEvent.click(await screen.findByTestId(`action-center-worker-${worker.id}`))

    const modal = await screen.findByTestId('worker-modal')
    expect(modal).toHaveAttribute('aria-label', 'Alice detail')
    expect(within(modal).getByTestId('worker-modal-terminal-slot')).toBeInTheDocument()
  })
})
