// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { AppWorkspaceContent } from '../../web/src/AppWorkspaceContent.js'
import type { TerminalRunSummary } from '../../web/src/api.js'
import type { WorkerActions } from '../../web/src/worker/useWorkerActions.js'

const shellRun = vi.hoisted<TerminalRunSummary>(() => ({
  agent_id: 'ws-1:shell',
  agent_name: 'Shell',
  run_id: 'run-shell-1',
  status: 'running',
}))

vi.mock('../../web/src/WorkspaceTerminalPanels.js', () => ({
  WorkspaceTerminalPanels: ({
    optimisticRuns,
    terminalRuns,
    workspaceId,
  }: {
    optimisticRuns?: TerminalRunSummary[]
    terminalRuns: TerminalRunSummary[]
    workspaceId: string
  }) => (
    <div data-testid="terminal-panels" data-workspace-id={workspaceId}>
      {[...terminalRuns, ...(optimisticRuns ?? [])].map((run) => run.run_id).join(',')}
    </div>
  ),
}))

vi.mock('../../web/src/WorkspaceDetail.js', () => ({
  WorkspaceDetail: ({
    onShellRunStarted,
  }: {
    onShellRunStarted?: (workspaceId: string, run: TerminalRunSummary) => void
  }) => (
    <button
      type="button"
      data-testid="emit-shell-run"
      onClick={() => onShellRunStarted?.('ws-1', shellRun)}
    >
      emit shell
    </button>
  ),
}))

afterEach(() => {
  cleanup()
})

const workspace: WorkspaceSummary = {
  id: 'ws-1',
  name: 'Alpha',
  path: '/tmp/alpha',
}

const workerActions: WorkerActions = {
  createWorker: vi.fn(),
  deleteWorker: vi.fn(),
  startWorker: vi.fn(),
  stopWorkerRun: vi.fn(),
}

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

describe('AppWorkspaceContent', () => {
  test('passes shell runs through the active workspace content boundary', () => {
    const onShellRunStarted = vi.fn()
    const inactiveRun: TerminalRunSummary = {
      agent_id: 'ws-2:shell',
      agent_name: 'Shell',
      run_id: 'inactive-shell-run',
      status: 'running',
    }
    const polledRun: TerminalRunSummary = {
      agent_id: `${workspace.id}:orchestrator`,
      agent_name: 'Orchestrator',
      run_id: 'polled-run',
      status: 'running',
    }

    render(
      <AppWorkspaceContent
        activeId={workspace.id}
        activeWorkspace={workspace}
        bootstrapError={null}
        demoMode={false}
        onDeleteWorkspace={vi.fn()}
        onExitDemo={vi.fn()}
        onRequestAddWorkspace={vi.fn()}
        onShellRunClosed={vi.fn()}
        onShellRunStarted={onShellRunStarted}
        onTryDemo={vi.fn()}
        optimisticRunsByWorkspaceId={{ [workspace.id]: [shellRun], 'ws-2': [inactiveRun] }}
        orchestratorAutostartErrors={{}}
        orchestratorAutostartRunIds={{}}
        recordOrchestratorResult={vi.fn()}
        tasksFile={mockTasksFile}
        terminalRuns={[polledRun]}
        workerActions={workerActions}
        workers={[]}
      />
    )

    expect(screen.getByTestId('terminal-panels')).toHaveAttribute('data-workspace-id', workspace.id)
    expect(screen.getByTestId('terminal-panels')).toHaveTextContent(polledRun.run_id)
    expect(screen.getByTestId('terminal-panels')).toHaveTextContent(shellRun.run_id)
    expect(screen.getByTestId('terminal-panels')).not.toHaveTextContent(inactiveRun.run_id)

    fireEvent.click(screen.getByTestId('emit-shell-run'))

    expect(onShellRunStarted).toHaveBeenCalledWith(workspace.id, shellRun)
  })
})
