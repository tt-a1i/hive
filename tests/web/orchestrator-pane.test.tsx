// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  OrchestratorPane,
  type OrchestratorPaneState,
} from '../../web/src/worker/OrchestratorPane.js'
import { renderMobile } from './helpers/mobile-render.js'

afterEach(() => {
  cleanup()
})

const runningState = (
  overrides: Partial<Extract<OrchestratorPaneState, { kind: 'running' }>> = {}
): Extract<OrchestratorPaneState, { kind: 'running' }> => ({
  hasUserInputSinceStart: true,
  kind: 'running',
  runId: 'run-abc',
  startupBlockedReason: null,
  ...overrides,
})

const renderPane = (state: OrchestratorPaneState, renderUi: typeof renderMobile = render) => {
  const onStart = vi.fn()
  const onRestart = vi.fn()
  const onRemoveWorkspace = vi.fn()
  renderUi(
    <OrchestratorPane
      state={state}
      onStart={onStart}
      onRestart={onRestart}
      onRemoveWorkspace={onRemoveWorkspace}
    />
  )
  return { onRemoveWorkspace, onStart, onRestart }
}

describe('OrchestratorPane three-state UI', () => {
  test('starting: shows passive startup state without a manual Start Orchestrator CTA', () => {
    const { onStart, onRestart } = renderPane({ kind: 'starting' })

    expect(screen.getByTestId('orchestrator-starting-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Starting Orchestrator')
    expect(screen.queryByTestId('orchestrator-start')).toBeNull()
    expect(screen.queryByText('Orchestrator is offline')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    expect(onStart).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('stopped: shows explicit Start Orchestrator CTA', () => {
    const { onStart, onRestart } = renderPane({ kind: 'stopped' })

    expect(screen.getByTestId('orchestrator-stopped-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Orchestrator is stopped')
    const start = screen.getByTestId('orchestrator-start')
    expect(start).toHaveTextContent('Start Orchestrator')

    fireEvent.click(start)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('running: PTY slot mounts without a visible Stop kill switch or first-dispatch guide', () => {
    const { onStart, onRestart } = renderPane(runningState({ hasUserInputSinceStart: false }))

    // PTY slot must use the run id so TerminalView can portal into it.
    const slot = document.getElementById('orch-pty-run-abc')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('orchestrator')
    expect(slot?.getAttribute('data-terminal-auto-focus')).toBe('true')

    expect(screen.queryByTestId('orchestrator-stop')).toBeNull()
    expect(screen.queryByTestId('orchestrator-restart')).toBeNull()
    expect(screen.queryByTestId('orchestrator-running-actions')).toBeNull()
    expect(screen.queryByTestId('orchestrator-first-dispatch-guide')).toBeNull()
    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-stopped-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    expect(onStart).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('running: desktop does not render a visible Connecting placeholder before portal attach', () => {
    renderPane(runningState())

    expect(screen.queryByTestId('orchestrator-running-placeholder')).toBeNull()
  })

  test('running: mobile keeps the temporary Connecting placeholder for first attach', () => {
    renderPane(runningState(), renderMobile)

    expect(screen.getByTestId('orchestrator-running-placeholder')).toHaveTextContent('Connecting')
  })

  test('failed: surfaces error string + Retry CTA, click dispatches onRestart', () => {
    const errorMessage = 'claude CLI not found in PATH'
    const { onRemoveWorkspace, onStart, onRestart } = renderPane({
      kind: 'failed',
      error: errorMessage,
    })

    expect(screen.getByTestId('orchestrator-failed-body')).toBeInTheDocument()
    expect(screen.getByTestId('orchestrator-error-message')).toHaveTextContent(errorMessage)
    const retryBody = screen.getByTestId('orchestrator-retry')
    expect(retryBody).toHaveTextContent('Retry')

    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()

    fireEvent.click(retryBody)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()

    const remove = screen.getByTestId('orchestrator-remove-workspace')
    expect(remove).toHaveTextContent('Remove workspace')
    fireEvent.click(remove)
    expect(onRemoveWorkspace).toHaveBeenCalledTimes(1)
  })
})
