// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import type { TerminalRunSummary } from '../../web/src/api.js'
import { closeWorkspaceShell, startWorkspaceShell } from '../../web/src/api.js'
import { NotificationProvider } from '../../web/src/notifications/NotificationProvider.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { WorkspaceDetail } from '../../web/src/WorkspaceDetail.js'

vi.mock('../../web/src/api.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../web/src/api.js')>('../../web/src/api.js')
  return {
    ...actual,
    closeWorkspaceShell: vi.fn(() => Promise.resolve()),
    renameWorker: vi.fn(() => Promise.resolve()),
    startWorkspaceShell: vi.fn(),
  }
})

const workspace: WorkspaceSummary = {
  id: 'ws-1',
  name: 'Alpha',
  path: '/tmp/alpha',
}

const workspaceTwo: WorkspaceSummary = {
  id: 'ws-2',
  name: 'Beta',
  path: '/tmp/beta',
}

const worker: TeamListItem = {
  id: 'worker-1',
  name: 'Alice',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'idle',
}

const shellRun = (runId = 'shell-run-1', workspaceId = workspace.id): TerminalRunSummary => ({
  agent_id: `${workspaceId}:shell`,
  agent_name: 'Shell',
  run_id: runId,
  status: 'running',
})

const workerRun = (): TerminalRunSummary => ({
  agent_id: worker.id,
  agent_name: worker.name,
  run_id: 'worker-run-1',
  status: 'running',
})

const mockTasksFile = {
  content: '',
  hasConflict: false,
  loaded: true,
  onChange: vi.fn(),
  onKeepLocal: vi.fn(),
  onReload: vi.fn(),
  onSave: vi.fn(async () => {}),
  toggleTaskAtLine: vi.fn(async () => {}),
  appendTask: vi.fn(async () => {}),
  appendSubtask: vi.fn(async () => {}),
  updateTaskText: vi.fn(async () => {}),
  deleteTask: vi.fn(async () => {}),
}

const renderWorkspaceDetail = ({
  onShellRunStarted,
  selectedWorkspace = workspace,
  terminalRuns = [],
}: {
  onShellRunStarted?: (workspaceId: string, run: TerminalRunSummary) => void
  selectedWorkspace?: WorkspaceSummary
  terminalRuns?: TerminalRunSummary[]
} = {}) => renderWorkspaceDetailUi({ onShellRunStarted, selectedWorkspace, terminalRuns })

const renderWorkspaceDetailUi = ({
  onShellRunStarted,
  selectedWorkspace,
  terminalRuns,
}: {
  onShellRunStarted?: ((workspaceId: string, run: TerminalRunSummary) => void) | undefined
  selectedWorkspace: WorkspaceSummary
  terminalRuns: TerminalRunSummary[]
}) =>
  render(
    <ToastProvider>
      <NotificationProvider>
        <WorkspaceDetail
          onCreateWorker={vi.fn()}
          onDeleteWorker={vi.fn()}
          onDeleteWorkspace={vi.fn()}
          onStartWorker={vi.fn()}
          onOrchestratorResult={vi.fn()}
          onRequestAddWorkspace={vi.fn()}
          onShellRunStarted={onShellRunStarted}
          orchestratorAutostartError={null}
          orchestratorAutostartRunId={null}
          tasksFile={mockTasksFile}
          terminalRuns={terminalRuns}
          workers={[worker]}
          workspace={selectedWorkspace}
        />
      </NotificationProvider>
    </ToastProvider>
  )

const workspaceDetailUi = ({
  onShellRunStarted,
  selectedWorkspace,
  terminalRuns,
}: {
  onShellRunStarted?: (workspaceId: string, run: TerminalRunSummary) => void
  selectedWorkspace: WorkspaceSummary
  terminalRuns: TerminalRunSummary[]
}) => (
  <ToastProvider>
    <NotificationProvider>
      <WorkspaceDetail
        onCreateWorker={vi.fn()}
        onDeleteWorker={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onStartWorker={vi.fn()}
        onOrchestratorResult={vi.fn()}
        onRequestAddWorkspace={vi.fn()}
        onShellRunStarted={onShellRunStarted}
        orchestratorAutostartError={null}
        orchestratorAutostartRunId={null}
        tasksFile={mockTasksFile}
        terminalRuns={terminalRuns}
        workers={[worker]}
        workspace={selectedWorkspace}
      />
    </NotificationProvider>
  </ToastProvider>
)

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(closeWorkspaceShell).mockReset()
  vi.mocked(closeWorkspaceShell).mockResolvedValue(undefined)
  vi.mocked(startWorkspaceShell).mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('WorkspaceDetail shell terminal button', () => {
  test('starts a workspace shell when there is no shell tab or shell run', async () => {
    const run = shellRun()
    const onShellRunStarted = vi.fn()
    vi.mocked(startWorkspaceShell).mockResolvedValue(run)

    const view = renderWorkspaceDetail({ onShellRunStarted })
    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    expect(startWorkspaceShell).toHaveBeenCalledTimes(1)
    expect(startWorkspaceShell).toHaveBeenCalledWith(workspace.id)
    await waitFor(() => {
      expect(onShellRunStarted).toHaveBeenCalledWith(workspace.id, run)
    })

    view.rerender(workspaceDetailUi({ selectedWorkspace: workspace, terminalRuns: [run] }))
    const panel = await screen.findByTestId('terminal-bottom-panel')
    expect(within(panel).getByTestId(`terminal-panel-slot-shell-${run.run_id}`)).toBeInTheDocument()
  })

  test('opens an observed shell run when it has no tab yet', async () => {
    const shell = shellRun()

    renderWorkspaceDetail({ terminalRuns: [shell] })
    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    const panel = await screen.findByTestId('terminal-bottom-panel')
    expect(
      within(panel).getByTestId(`terminal-panel-slot-shell-${shell.run_id}`)
    ).toBeInTheDocument()
    expect(startWorkspaceShell).not.toHaveBeenCalled()
  })

  test('panel close hides the shell panel without stopping the shell and Terminal restores it', async () => {
    const shell = shellRun()
    window.localStorage.setItem(
      `hive.terminal-panel.tabs.${workspace.id}`,
      JSON.stringify([`shell:${shell.run_id}`])
    )
    window.localStorage.setItem(
      `hive.terminal-panel.active.${workspace.id}`,
      `shell:${shell.run_id}`
    )

    renderWorkspaceDetail({ terminalRuns: [shell] })
    const panel = await screen.findByTestId('terminal-bottom-panel')
    expect(
      within(panel).getByTestId(`terminal-panel-slot-shell-${shell.run_id}`)
    ).toBeInTheDocument()

    fireEvent.click(within(panel).getByTestId('terminal-panel-close'))

    // Panel collapse hides content via aria-hidden; the section is still in the DOM
    const terminalSection = screen.getByTestId('panel-toggle-terminal')
    expect(terminalSection).toHaveAttribute('aria-expanded', 'false')
    expect(closeWorkspaceShell).not.toHaveBeenCalled()

    // Clicking open-workspace-shell uncollapses the terminal panel
    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    await waitFor(() => {
      expect(screen.getByTestId('panel-toggle-terminal')).toHaveAttribute('aria-expanded', 'true')
    })
    const reopenedPanel = screen.getByTestId('terminal-bottom-panel')
    expect(
      within(reopenedPanel).getByTestId(`terminal-panel-slot-shell-${shell.run_id}`)
    ).toBeInTheDocument()
    expect(startWorkspaceShell).not.toHaveBeenCalled()
  })

  test('waits for a locally closing shell run before starting a replacement', async () => {
    const closingRun = shellRun()
    const run = shellRun('shell-run-2')
    const close = deferred<void>()
    window.localStorage.setItem(
      `hive.terminal-panel.tabs.${workspace.id}`,
      JSON.stringify([`shell:${closingRun.run_id}`])
    )
    window.localStorage.setItem(
      `hive.terminal-panel.active.${workspace.id}`,
      `shell:${closingRun.run_id}`
    )
    vi.mocked(closeWorkspaceShell).mockReturnValue(close.promise)
    vi.mocked(startWorkspaceShell).mockResolvedValue(run)

    const view = renderWorkspaceDetail({ terminalRuns: [closingRun] })
    const panel = await screen.findByTestId('terminal-bottom-panel')
    fireEvent.click(within(panel).getByTestId(`terminal-tab-close-shell:${closingRun.run_id}`))
    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    expect(closeWorkspaceShell).toHaveBeenCalledWith(workspace.id, closingRun.run_id)
    expect(startWorkspaceShell).not.toHaveBeenCalled()

    await act(async () => {
      close.resolve()
      await close.promise
    })

    await waitFor(() => {
      expect(startWorkspaceShell).toHaveBeenCalledTimes(1)
    })
    expect(startWorkspaceShell).toHaveBeenCalledTimes(1)
    expect(startWorkspaceShell).toHaveBeenCalledWith(workspace.id)

    view.rerender(
      workspaceDetailUi({ selectedWorkspace: workspace, terminalRuns: [closingRun, run] })
    )
    const reopenedPanel = await screen.findByTestId('terminal-bottom-panel')
    expect(
      within(reopenedPanel).getByTestId(`terminal-panel-slot-shell-${run.run_id}`)
    ).toBeInTheDocument()
  })

  test('focuses an existing shell tab without starting another shell', async () => {
    const shell = shellRun()
    window.localStorage.setItem(
      `hive.terminal-panel.tabs.${workspace.id}`,
      JSON.stringify([`worker:${worker.id}`, `shell:${shell.run_id}`])
    )
    window.localStorage.setItem(`hive.terminal-panel.active.${workspace.id}`, `worker:${worker.id}`)

    renderWorkspaceDetail({ terminalRuns: [workerRun(), shell] })
    const panel = await screen.findByTestId('terminal-bottom-panel')
    expect(within(panel).queryByTestId(`terminal-panel-slot-worker-${worker.id}`)).toBeNull()
    expect(
      within(panel).getByTestId(`terminal-panel-slot-shell-${shell.run_id}`)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    await waitFor(() => {
      expect(
        within(panel).getByTestId(`terminal-panel-slot-shell-${shell.run_id}`)
      ).toBeInTheDocument()
    })
    expect(startWorkspaceShell).not.toHaveBeenCalled()
  })

  test('ignores a resolved shell start after switching workspaces', async () => {
    const ws1Start = deferred<TerminalRunSummary>()
    const ws2Run = shellRun('ws-2-shell-run-1', workspaceTwo.id)
    vi.mocked(startWorkspaceShell)
      .mockReturnValueOnce(ws1Start.promise)
      .mockResolvedValueOnce(ws2Run)

    const view = renderWorkspaceDetail()
    fireEvent.click(screen.getByTestId('open-workspace-shell'))
    expect(startWorkspaceShell).toHaveBeenCalledWith(workspace.id)

    view.rerender(workspaceDetailUi({ selectedWorkspace: workspaceTwo, terminalRuns: [] }))
    const lateWs1Run = shellRun('ws-1-late-shell-run', workspace.id)
    await act(async () => {
      ws1Start.resolve(lateWs1Run)
      await ws1Start.promise
    })

    const storedTabs = window.localStorage.getItem(`hive.terminal-panel.tabs.${workspaceTwo.id}`)
    expect(storedTabs ?? '').not.toContain(lateWs1Run.run_id)
    expect(screen.queryByTestId('terminal-bottom-panel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('open-workspace-shell'))
    expect(startWorkspaceShell).toHaveBeenCalledTimes(2)
    expect(startWorkspaceShell).toHaveBeenLastCalledWith(workspaceTwo.id)

    view.rerender(workspaceDetailUi({ selectedWorkspace: workspaceTwo, terminalRuns: [ws2Run] }))
    const panel = await screen.findByTestId('terminal-bottom-panel')
    expect(
      within(panel).getByTestId(`terminal-panel-slot-shell-${ws2Run.run_id}`)
    ).toBeInTheDocument()
  })

  test('does not start more than one workspace shell while a start is in flight', () => {
    vi.mocked(startWorkspaceShell).mockReturnValue(new Promise(() => {}))

    renderWorkspaceDetail()
    fireEvent.click(screen.getByTestId('open-workspace-shell'))
    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    expect(startWorkspaceShell).toHaveBeenCalledTimes(1)
  })

  test('keeps a pending shell start locked to its workspace across workspace switches', async () => {
    const ws1Start = deferred<TerminalRunSummary>()
    const onShellRunStarted = vi.fn()
    vi.mocked(startWorkspaceShell).mockReturnValueOnce(ws1Start.promise)

    const view = renderWorkspaceDetail({ onShellRunStarted })
    fireEvent.click(screen.getByTestId('open-workspace-shell'))
    expect(startWorkspaceShell).toHaveBeenCalledTimes(1)
    expect(startWorkspaceShell).toHaveBeenLastCalledWith(workspace.id)

    view.rerender(workspaceDetailUi({ selectedWorkspace: workspaceTwo, terminalRuns: [] }))
    view.rerender(workspaceDetailUi({ selectedWorkspace: workspace, terminalRuns: [] }))
    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    expect(startWorkspaceShell).toHaveBeenCalledTimes(1)

    const lateWs1Run = shellRun('ws-1-late-shell-run', workspace.id)
    await act(async () => {
      ws1Start.resolve(lateWs1Run)
      await ws1Start.promise
    })
    expect(onShellRunStarted).toHaveBeenCalledWith(workspace.id, lateWs1Run)

    view.rerender(workspaceDetailUi({ selectedWorkspace: workspace, terminalRuns: [lateWs1Run] }))
    fireEvent.click(screen.getByTestId('open-workspace-shell'))
    expect(startWorkspaceShell).toHaveBeenCalledTimes(1)

    const panel = await screen.findByTestId('terminal-bottom-panel')
    expect(
      within(panel).getByTestId(`terminal-panel-slot-shell-${lateWs1Run.run_id}`)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    expect(startWorkspaceShell).toHaveBeenCalledTimes(1)
  })

  test('reopens an optimistically observed shell run without a timeout window', async () => {
    const startedRun = shellRun('ws-1-started-but-not-polled', workspace.id)
    vi.mocked(startWorkspaceShell).mockResolvedValue(startedRun)

    const view = renderWorkspaceDetail()
    fireEvent.click(screen.getByTestId('open-workspace-shell'))
    await waitFor(() => {
      expect(startWorkspaceShell).toHaveBeenCalledTimes(1)
    })

    view.rerender(workspaceDetailUi({ selectedWorkspace: workspace, terminalRuns: [startedRun] }))
    fireEvent.click(screen.getByTestId('open-workspace-shell'))

    expect(startWorkspaceShell).toHaveBeenCalledTimes(1)
  })
})
