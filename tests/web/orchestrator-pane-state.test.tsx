// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { useOrchestratorPaneState } from '../../web/src/worker/useOrchestratorPaneState.js'

const { startAgentRun } = vi.hoisted(() => ({ startAgentRun: vi.fn() }))

vi.mock('../../web/src/api.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../web/src/api.js')>('../../web/src/api.js')
  return {
    ...actual,
    startAgentRun: (...args: unknown[]) => startAgentRun(...args),
    stopAgentRun: vi.fn(),
  }
})

afterEach(() => {
  cleanup()
  startAgentRun.mockReset()
})

const Harness = () => {
  const orchestrator = useOrchestratorPaneState({
    workspaceId: 'workspace-1',
    terminalRuns: [],
    autostartError: null,
    onClearAutostartError: vi.fn(),
  })

  return (
    <button type="button" data-testid="state" onClick={orchestrator.start}>
      {orchestrator.state.kind}
    </button>
  )
}

describe('useOrchestratorPaneState restart semantics', () => {
  test('no live run renders stopped and does not autostart', async () => {
    render(<Harness />)

    expect(screen.getByTestId('state')).toHaveTextContent('stopped')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(startAgentRun).not.toHaveBeenCalled()
  })

  test('manual start moves through starting and calls the start endpoint', async () => {
    startAgentRun.mockResolvedValueOnce({ runId: 'run-1' })
    render(<Harness />)

    fireEvent.click(screen.getByTestId('state'))

    expect(screen.getByTestId('state')).toHaveTextContent('starting')
    await waitFor(() => {
      expect(startAgentRun).toHaveBeenCalledWith('workspace-1', 'workspace-1:orchestrator')
    })
  })
})
