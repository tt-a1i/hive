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

describe('OrchestratorPane three-state UI (M5.4)', () => {
  test('idle: shows ▶ Start Queen primary CTA, click dispatches onStart', () => {
    const { onStart, onStop, onRestart } = renderPane({ kind: 'idle' })

    const startBtn = screen.getByTestId('orchestrator-start')
    expect(startBtn).toHaveTextContent('▶ Start Queen')
    expect(screen.getByTestId('orchestrator-idle-body')).toBeInTheDocument()
    expect(screen.queryByTestId('orchestrator-running-actions')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    fireEvent.click(startBtn)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('running: header exposes ⏹ Stop + ↻ Restart, PTY slot mounts with run id', () => {
    const { onStart, onStop, onRestart } = renderPane({ kind: 'running', runId: 'run-abc' })

    const stopBtn = screen.getByTestId('orchestrator-stop')
    const restartBtn = screen.getByTestId('orchestrator-restart')
    expect(stopBtn).toHaveTextContent('⏹ Stop')
    expect(restartBtn).toHaveTextContent('↻ Restart')

    // PTY slot must use the run id so TerminalView can portal into it.
    const slot = document.getElementById('orch-pty-run-abc')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('orchestrator')

    // Idle / failed bodies must be absent in running state.
    expect(screen.queryByTestId('orchestrator-idle-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    fireEvent.click(stopBtn)
    fireEvent.click(restartBtn)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })

  test('failed: surfaces error string + Retry CTA, click dispatches onRestart', () => {
    const errorMessage = 'claude CLI not found in PATH'
    const { onStart, onStop, onRestart } = renderPane({ kind: 'failed', error: errorMessage })

    expect(screen.getByTestId('orchestrator-failed-body')).toBeInTheDocument()
    expect(screen.getByTestId('orchestrator-failed-error')).toHaveTextContent(errorMessage)
    // Both Retry CTAs (header + body) must dispatch onRestart so the user can
    // recover from either entry point.
    expect(screen.getByTestId('orchestrator-retry-header')).toHaveTextContent('↻ Retry')
    const retryBody = screen.getByTestId('orchestrator-retry')
    expect(retryBody).toHaveTextContent('↻ Retry')

    // Idle body must NOT show in failed state — failed path is a hard-fail UX.
    expect(screen.queryByTestId('orchestrator-idle-body')).toBeNull()

    fireEvent.click(retryBody)
    expect(onRestart).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('orchestrator-retry-header'))
    expect(onRestart).toHaveBeenCalledTimes(2)
    expect(onStart).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })
})
