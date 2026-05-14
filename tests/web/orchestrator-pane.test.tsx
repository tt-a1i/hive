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
  const onStop = vi.fn()
  const onStart = vi.fn()
  const onRestart = vi.fn()
  const onRemoveWorkspace = vi.fn()
  render(
    <OrchestratorPane
      state={state}
      onStop={onStop}
      onStart={onStart}
      onRestart={onRestart}
      onRemoveWorkspace={onRemoveWorkspace}
    />
  )
  return { onRemoveWorkspace, onStop, onStart, onRestart }
}

describe('OrchestratorPane three-state UI', () => {
  test('starting: shows passive startup state without a manual Start Queen CTA', () => {
    const { onStop, onStart, onRestart } = renderPane({ kind: 'starting' })

    expect(screen.getByTestId('orchestrator-starting-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Starting Queen')
    expect(screen.queryByTestId('orchestrator-start')).toBeNull()
    expect(screen.queryByText('Queen is offline')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    expect(onStop).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('stopped: shows explicit Start Queen CTA', () => {
    const { onStop, onStart, onRestart } = renderPane({ kind: 'stopped' })

    expect(screen.getByTestId('orchestrator-stopped-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Queen is stopped')
    const start = screen.getByTestId('orchestrator-start')
    expect(start).toHaveTextContent('Start Queen')

    fireEvent.click(start)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('running: PTY slot mounts; no overlay actions or empty bodies render', () => {
    const { onStop, onStart, onRestart } = renderPane({ kind: 'running', runId: 'run-abc' })

    // PTY slot must use the run id so TerminalView can portal into it.
    const slot = document.getElementById('orch-pty-run-abc')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('orchestrator')

    // Stop / Restart / status pill / overlay are all gone — actions surface
    // through other channels (M6-B palette / WorkerModal). The pane is just
    // a PTY in running state.
    expect(screen.queryByTestId('orchestrator-stop')).toBeNull()
    expect(screen.queryByTestId('orchestrator-restart')).toBeNull()
    expect(screen.queryByTestId('orchestrator-running-actions')).toBeNull()
    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-stopped-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    expect(onStop).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('failed: surfaces error string + Retry CTA, click dispatches onRestart', () => {
    const errorMessage = 'claude CLI not found in PATH'
    const { onRemoveWorkspace, onStop, onStart, onRestart } = renderPane({
      kind: 'failed',
      error: errorMessage,
    })

    expect(screen.getByTestId('orchestrator-failed-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-description')).toHaveTextContent(errorMessage)
    const retryBody = screen.getByTestId('orchestrator-retry')
    expect(retryBody).toHaveTextContent('Retry')

    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()

    fireEvent.click(retryBody)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()

    const remove = screen.getByTestId('orchestrator-remove-workspace')
    expect(remove).toHaveTextContent('Remove workspace')
    fireEvent.click(remove)
    expect(onRemoveWorkspace).toHaveBeenCalledTimes(1)
  })
})
