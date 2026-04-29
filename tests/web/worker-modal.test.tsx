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

describe('WorkerModal destructive-action confirm guard', () => {
  test('Stop click with confirm=true forwards to onStop with the run id', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onStop } = renderModal()

    fireEvent.click(screen.getByTestId('worker-stop'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledWith('run-1')
  })

  test('Stop click with confirm=false leaves onStop untouched', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { onStop } = renderModal()

    fireEvent.click(screen.getByTestId('worker-stop'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  test('Restart click with confirm=true forwards to onRestart with worker + run id', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const worker = buildWorker()
    const { onRestart } = renderModal({ worker })

    fireEvent.click(screen.getByTestId('worker-restart'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledWith(worker, 'run-1')
  })

  test('Restart click with confirm=false leaves onRestart untouched', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { onRestart, onStart } = renderModal()

    fireEvent.click(screen.getByTestId('worker-restart'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onRestart).not.toHaveBeenCalled()
    // Restart on a stopped worker (no runId) calls onStart instead — but here
    // we have a runId, so the no-confirm path should NOT fall through to start.
    expect(onStart).not.toHaveBeenCalled()
  })

  test('Restart with no runId is a Start path and skips confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const stoppedWorker = buildWorker({ status: 'stopped' })
    // runId=null → only Start button is rendered, but the user-facing flow for
    // a stopped worker offers Start. Verify Start does NOT prompt confirm
    // (starting is non-destructive).
    const { onStart } = renderModal({ runId: null, worker: stoppedWorker })

    fireEvent.click(screen.getByTestId('worker-start'))
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith(stoppedWorker)
  })
})
