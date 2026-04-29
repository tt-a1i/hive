// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'
import { WorkerModal } from '../../web/src/worker/WorkerModal.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const buildWorker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  id: 'worker-1',
  name: 'Alice',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'working',
  ...overrides,
})

const renderModal = (
  options: {
    worker?: TeamListItem
    runId?: string | null
    starting?: boolean
    startError?: string | null
  } = {}
) => {
  const onClose = vi.fn()
  const onDelete = vi.fn()
  const onStart = vi.fn()
  const onStop = vi.fn().mockResolvedValue({ error: null })
  const onRestart = vi.fn().mockResolvedValue({ error: null })
  render(
    <WorkerModal
      onClose={onClose}
      onDelete={onDelete}
      onRestart={onRestart}
      onStart={onStart}
      onStop={onStop}
      runId={options.runId === undefined ? 'run-1' : options.runId}
      startError={options.startError ?? null}
      starting={options.starting ?? false}
      worker={options.worker ?? buildWorker()}
    />
  )
  return { onClose, onDelete, onStart, onStop, onRestart }
}

describe('WorkerModal — destructive actions go through Confirm dialog', () => {
  test('Stop opens Confirm with worker name; confirm-action dispatches onStop(runId)', () => {
    const { onStop } = renderModal()

    fireEvent.click(screen.getByTestId('worker-stop'))
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Stop Alice?')
    expect(onStop).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('confirm-action'))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledWith('run-1')
  })

  test('Stop → Cancel keeps onStop untouched', () => {
    const { onStop } = renderModal()
    fireEvent.click(screen.getByTestId('worker-stop'))
    fireEvent.click(screen.getByTestId('confirm-cancel'))
    expect(onStop).not.toHaveBeenCalled()
  })

  test('Restart opens Confirm; confirm-action dispatches onRestart(worker, runId)', () => {
    const worker = buildWorker()
    const { onRestart } = renderModal({ worker })
    fireEvent.click(screen.getByTestId('worker-restart'))
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Restart Alice?')

    fireEvent.click(screen.getByTestId('confirm-action'))
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledWith(worker, 'run-1')
  })

  test('Delete opens danger Confirm; confirm-action dispatches onDelete(worker)', () => {
    const worker = buildWorker()
    const { onDelete } = renderModal({ worker })
    fireEvent.click(screen.getByTestId('worker-delete'))
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Delete Alice?')
    expect(screen.getByTestId('confirm-action').className).toContain('icon-btn--danger')

    fireEvent.click(screen.getByTestId('confirm-action'))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(worker)
  })

  test('Start (no runId) is non-destructive — no Confirm, dispatches immediately', () => {
    const stoppedWorker = buildWorker({ status: 'stopped' })
    const { onStart } = renderModal({ runId: null, worker: stoppedWorker })

    fireEvent.click(screen.getByTestId('worker-start'))
    expect(screen.queryByTestId('confirm-title')).toBeNull()
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith(stoppedWorker)
  })
})
