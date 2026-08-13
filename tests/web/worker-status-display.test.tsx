// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'
import type { TerminalRunSummary } from '../../web/src/api.js'
import { WorkerCard } from '../../web/src/worker/WorkerCard.js'
import { WorkersPane } from '../../web/src/worker/WorkersPane.js'

afterEach(() => {
  cleanup()
})

const worker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  id: 'worker-1',
  name: 'ember-check-23',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'idle',
  ...overrides,
})

const terminalRun = (agentId: string): TerminalRunSummary => ({
  agent_id: agentId,
  agent_name: agentId,
  run_id: `run-${agentId}`,
  status: 'running',
})

describe('worker status presentation', () => {
  test('worker card keeps an idle worker idle even when its PTY is running', () => {
    render(
      <WorkerCard
        hasRun
        onClick={vi.fn()}
        onAction={vi.fn()}
        worker={worker({ id: 'idle-worker', status: 'idle' })}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('idle')
    expect(screen.getByTestId('worker-card-idle-worker')).toHaveAttribute('data-status', 'idle')
    expect(screen.queryByLabelText('Start ember-check-23')).toBeNull()
  })

  test('workers pane groups idle running PTYs separately from active work', () => {
    const idleWorker = worker({ id: 'idle-worker', name: 'idle-agent', status: 'idle' })
    const activeWorker = worker({ id: 'active-worker', name: 'active-agent', status: 'working' })
    const stoppedWorker = worker({
      id: 'stopped-worker',
      name: 'stopped-agent',
      status: 'stopped',
    })

    render(
      <WorkersPane
        onAddWorkerClick={vi.fn()}
        onDeleteWorker={vi.fn()}
        onOpenWorker={vi.fn()}
        onRenameWorker={vi.fn()}
        onStartWorker={vi.fn()}
        onStopWorkerRun={vi.fn()}
        startingWorkerId={null}
        terminalRuns={[terminalRun(idleWorker.id), terminalRun(activeWorker.id)]}
        workers={[idleWorker, activeWorker, stoppedWorker]}
      />
    )

    expect(screen.getByRole('list', { name: 'running team members' })).toBeInTheDocument()
    const idleList = screen.getByRole('list', { name: 'idle team members' })
    expect(screen.getByRole('list', { name: 'stopped team members' })).toBeInTheDocument()

    expect(within(idleList).getByText('idle-agent')).toBeInTheDocument()
    expect(within(idleList).queryByText('active-agent')).toBeNull()
  })
})
