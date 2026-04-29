// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  OrchestratorPane,
  type OrchestratorPaneState,
} from '../../web/src/worker/OrchestratorPane.js'

afterEach(() => {
  cleanup()
})

const renderPane = (state: OrchestratorPaneState) => {
  const onStart = vi.fn()
  const onStop = vi.fn()
  const onRestart = vi.fn()
  render(<OrchestratorPane state={state} onStart={onStart} onStop={onStop} onRestart={onRestart} />)
  return { onStart, onStop, onRestart }
}

describe('OrchestratorPane three-state UI', () => {
  test('idle: shows Start Queen primary CTA, click dispatches onStart', () => {
    const { onStart, onStop, onRestart } = renderPane({ kind: 'idle' })

    const startBtn = screen.getByTestId('orchestrator-start')
    expect(startBtn).toHaveTextContent('Start Queen')
    expect(screen.getByTestId('orchestrator-idle-body')).toBeInTheDocument()
    expect(screen.queryByTestId('orchestrator-running-actions')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    fireEvent.click(startBtn)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('running: clicking Stop opens Confirm dialog; confirming triggers onStop', () => {
    const { onStart, onStop, onRestart } = renderPane({ kind: 'running', runId: 'run-abc' })

    const stopBtn = screen.getByTestId('orchestrator-stop')
    const restartBtn = screen.getByTestId('orchestrator-restart')
    expect(stopBtn).toBeInTheDocument()
    expect(restartBtn).toBeInTheDocument()

    // PTY slot must use the run id so TerminalView can portal into it.
    const slot = document.getElementById('orch-pty-run-abc')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('orchestrator')

    // Idle / failed bodies must be absent in running state.
    expect(screen.queryByTestId('orchestrator-idle-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    // Click Stop → Confirm dialog opens → onStop only after confirm-action.
    fireEvent.click(stopBtn)
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Stop Queen?')
    expect(onStop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('confirm-action'))
    expect(onStop).toHaveBeenCalledTimes(1)

    // Click Restart → Confirm dialog opens with restart copy → onRestart fires.
    fireEvent.click(restartBtn)
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Restart Queen?')
    fireEvent.click(screen.getByTestId('confirm-action'))
    expect(onRestart).toHaveBeenCalledTimes(1)

    expect(onStart).not.toHaveBeenCalled()
  })

  test('running: clicking Stop then Cancel keeps PTY alive', () => {
    const { onStop, onRestart } = renderPane({ kind: 'running', runId: 'run-abc' })

    fireEvent.click(screen.getByTestId('orchestrator-stop'))
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Stop Queen?')
    fireEvent.click(screen.getByTestId('confirm-cancel'))
    expect(onStop).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('orchestrator-restart'))
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Restart Queen?')
    fireEvent.click(screen.getByTestId('confirm-cancel'))
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('Confirm closes if PTY exits while dialog is open (B3 regression)', () => {
    // User clicks Stop → Confirm opens → PTY exits naturally → state flips to
    // idle. The pending Confirm dialog must close so the user can't click an
    // action that no longer matches reality (would silently no-op upstream).
    const onStop = vi.fn()
    const onStart = vi.fn()
    const onRestart = vi.fn()
    const { rerender } = render(
      <OrchestratorPane
        state={{ kind: 'running', runId: 'run-abc' }}
        onStart={onStart}
        onStop={onStop}
        onRestart={onRestart}
      />
    )
    fireEvent.click(screen.getByTestId('orchestrator-stop'))
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Stop Queen?')

    // PTY exit happens upstream — state.kind switches to 'idle'.
    rerender(
      <OrchestratorPane
        state={{ kind: 'idle' }}
        onStart={onStart}
        onStop={onStop}
        onRestart={onRestart}
      />
    )
    // Dialog must be gone; user did not get a chance to click stale confirm.
    expect(screen.queryByTestId('confirm-title')).toBeNull()
    expect(onStop).not.toHaveBeenCalled()
  })

  test('failed: surfaces error string + Retry CTA, click dispatches onRestart', () => {
    const errorMessage = 'claude CLI not found in PATH'
    const { onStart, onStop, onRestart } = renderPane({ kind: 'failed', error: errorMessage })

    expect(screen.getByTestId('orchestrator-failed-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-description')).toHaveTextContent(errorMessage)
    // Header was removed; only the body Retry CTA remains. Header testid is
    // kept as an sr-only alias for back-compat (cannot be clicked).
    const retryBody = screen.getByTestId('orchestrator-retry')
    expect(retryBody).toHaveTextContent('Retry')

    // Idle body must NOT show in failed state — failed path is a hard-fail UX.
    expect(screen.queryByTestId('orchestrator-idle-body')).toBeNull()

    fireEvent.click(retryBody)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })
})
