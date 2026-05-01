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
  const onStart = vi.fn()
  render(
    <WorkerModal
      onClose={onClose}
      onStart={onStart}
      runId={options.runId === undefined ? 'run-1' : options.runId}
      startError={options.startError ?? null}
      starting={options.starting ?? false}
      worker={options.worker ?? buildWorker()}
    />
  )
  return { onClose, onStart }
}

describe('WorkerModal — pure PTY view (control actions live on WorkerCard)', () => {
  test('mounts the PTY slot when runId is provided', () => {
    const runId = 'run-abc'
    renderModal({ runId })
    const slot = document.getElementById(`worker-pty-${runId}`)
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('worker')
  })

  test('renders the empty-state Start affordance when no PTY is running', () => {
    const stoppedWorker = buildWorker({ status: 'stopped' })
    const { onStart } = renderModal({ runId: null, worker: stoppedWorker })

    fireEvent.click(screen.getByTestId('worker-start-empty'))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith(stoppedWorker)
  })

  test('Close button dispatches onClose via Dialog close', () => {
    const { onClose } = renderModal()
    fireEvent.click(screen.getByLabelText('Close worker detail'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('startError surfaces as an alert banner', () => {
    renderModal({ startError: 'claude CLI not found in PATH', runId: null })
    expect(screen.getByRole('alert')).toHaveTextContent('claude CLI not found in PATH')
  })

  test('control actions (Stop / Restart / Delete) are NOT rendered inside the modal', () => {
    renderModal()
    expect(screen.queryByTestId('worker-stop')).toBeNull()
    expect(screen.queryByTestId('worker-restart')).toBeNull()
    expect(screen.queryByTestId('worker-delete')).toBeNull()
    // (Card-level testids: worker-card-stop-*, worker-card-restart-*, worker-card-delete-*)
  })
})
