// @vitest-environment jsdom
//
// M5b impl:adapt-b — the WorkflowsDrawer is a full-screen page on mobile
// (data-mobile on the dialog content), and all desktop run controls (expand,
// Stop run, schedule pause/delete, narrator logs) stay reachable + invokable.
// Parity row: "workflows (list/detail/Stop/Retry/logs)". "Retry" maps to the
// orchestrator re-firing + the observation surface, NOT a missing button — so
// the test asserts the controls that DO exist.

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { WorkflowsDrawer } from '../../web/src/workflows/WorkflowsDrawer.js'
import { renderMobile, renderWide } from './helpers/mobile-render.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const RUN: api.WorkflowRun = {
  id: 'run-1',
  workspaceId: 'ws-1',
  scriptPath: '/repo/.hive/workflows/audit.ts',
  name: 'audit pass',
  status: 'running',
  startedAt: Date.now() - 5000,
  finishedAt: null,
  error: null,
  phase: 'recon',
  result: null,
  args: null,
  agentCount: 2,
  parentRunId: null,
}

const SCHEDULE: api.WorkflowSchedule = {
  id: 'sch-1',
  workspaceId: 'ws-1',
  scriptPath: '/repo/.hive/workflows/nightly.ts',
  cron: '0 3 * * *',
  enabled: true,
} as api.WorkflowSchedule

beforeEach(() => {
  vi.spyOn(api, 'listWorkflowRuns').mockResolvedValue([RUN])
  vi.spyOn(api, 'listWorkflowSchedules').mockResolvedValue([SCHEDULE])
  vi.spyOn(api, 'getWorkflowCliPolicy').mockResolvedValue({
    default: 'claude',
    allowed: ['claude'],
    supported: ['claude'],
  })
  vi.spyOn(api, 'listWorkflowRunDispatches').mockResolvedValue([])
  vi.spyOn(api, 'listWorkflowRunLogs').mockResolvedValue([])
})

const withI18n = (ui: React.ReactElement) => (
  <I18nProvider>
    <ToastProvider>{ui}</ToastProvider>
  </I18nProvider>
)

describe('mobile WorkflowsDrawer — full-screen page', () => {
  test('mobile drawer tags the dialog content data-mobile (full-bleed)', async () => {
    renderMobile(withI18n(<WorkflowsDrawer open onClose={vi.fn()} workspaceId="ws-1" />))
    const content = await screen.findByTestId('workflows-drawer')
    expect(content).toHaveAttribute('data-mobile', 'true')
  })

  test('desktop drawer does NOT tag data-mobile (zero-regression)', async () => {
    renderWide(withI18n(<WorkflowsDrawer open onClose={vi.fn()} workspaceId="ws-1" />))
    const content = await screen.findByTestId('workflows-drawer')
    expect(content).not.toHaveAttribute('data-mobile')
  })

  test('mobile: run row Stop is reachable and calls stopWorkflowRun', async () => {
    const stop = vi.spyOn(api, 'stopWorkflowRun').mockResolvedValue(undefined)
    renderMobile(withI18n(<WorkflowsDrawer open onClose={vi.fn()} workspaceId="ws-1" />))
    const stopBtn = await screen.findByTestId('workflow-run-stop-run-1')
    fireEvent.click(stopBtn)
    await waitFor(() => expect(stop).toHaveBeenCalledWith('run-1'))
  })

  test('mobile: schedule pause + delete reachable and call the schedule APIs', async () => {
    const update = vi
      .spyOn(api, 'updateWorkflowSchedule')
      .mockResolvedValue(
        undefined as unknown as Awaited<ReturnType<typeof api.updateWorkflowSchedule>>
      )
    const del = vi.spyOn(api, 'deleteWorkflowSchedule').mockResolvedValue(undefined)
    renderMobile(withI18n(<WorkflowsDrawer open onClose={vi.fn()} workspaceId="ws-1" />))
    fireEvent.click(await screen.findByTestId('workflow-schedule-toggle-sch-1'))
    await waitFor(() => expect(update).toHaveBeenCalledWith('sch-1', { enabled: false }))
    fireEvent.click(screen.getByTestId('workflow-schedule-delete-sch-1'))
    await waitFor(() => expect(del).toHaveBeenCalledWith('sch-1'))
  })

  test('mobile: expanding a run fetches its logs lane (observation surface)', async () => {
    const dispatches = vi.spyOn(api, 'listWorkflowRunDispatches').mockResolvedValue([])
    renderMobile(withI18n(<WorkflowsDrawer open onClose={vi.fn()} workspaceId="ws-1" />))
    fireEvent.click(await screen.findByTestId('workflow-run-toggle-run-1'))
    await waitFor(() => expect(dispatches).toHaveBeenCalledWith('run-1'))
    expect(await screen.findByTestId('workflow-run-detail-run-1')).toBeTruthy()
  })
})
