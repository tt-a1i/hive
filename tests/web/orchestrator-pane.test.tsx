// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  OrchestratorPane,
  type OrchestratorPaneState,
} from '../../web/src/worker/OrchestratorPane.js'

afterEach(() => {
  cleanup()
})

const renderPane = (
  state: OrchestratorPaneState,
  extraProps?: { hasUserInput?: boolean; markUserInput?: () => void }
) => {
  const onStop = vi.fn()
  const onRestart = vi.fn()
  render(
    <OrchestratorPane
      state={state}
      onStop={onStop}
      onRestart={onRestart}
      hasUserInput={extraProps?.hasUserInput ?? false}
      markUserInput={extraProps?.markUserInput ?? (() => {})}
    />
  )
  return { onStop, onRestart }
}

/** Stateful host that lets the Dismiss action flip hasUserInput=true. */
const StatefulPaneHost = ({ state }: { state: OrchestratorPaneState }) => {
  const [hasUserInput, setHasUserInput] = useState(false)
  return (
    <OrchestratorPane
      state={state}
      onStop={() => {}}
      onRestart={() => {}}
      hasUserInput={hasUserInput}
      markUserInput={() => setHasUserInput(true)}
    />
  )
}

describe('OrchestratorPane three-state UI', () => {
  test('starting: shows passive startup state without a manual Start Queen CTA', () => {
    const { onStop, onRestart } = renderPane({ kind: 'starting' })

    expect(screen.getByTestId('orchestrator-starting-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Starting Queen')
    expect(screen.queryByTestId('orchestrator-start')).toBeNull()
    expect(screen.queryByText('Queen is offline')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    expect(onStop).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('running: PTY slot mounts; no overlay actions or empty bodies render', () => {
    const { onStop, onRestart } = renderPane({ kind: 'running', runId: 'run-abc' })

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
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    expect(onStop).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('failed: surfaces error string + Retry CTA, click dispatches onRestart', () => {
    const errorMessage = 'claude CLI not found in PATH'
    const { onStop, onRestart } = renderPane({ kind: 'failed', error: errorMessage })

    expect(screen.getByTestId('orchestrator-failed-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-description')).toHaveTextContent(errorMessage)
    const retryBody = screen.getByTestId('orchestrator-retry')
    expect(retryBody).toHaveTextContent('Retry')

    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()

    fireEvent.click(retryBody)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })
})

describe('OrchestratorPane hint overlay integration', () => {
  test('hint overlay shows when Orchestrator is running with no input yet', () => {
    renderPane({ kind: 'running', runId: 'run-hint' }, { hasUserInput: false })
    expect(screen.getByTestId('orch-hint')).toBeInTheDocument()
  })

  test('clicking Dismiss on hint hides the overlay', () => {
    render(<StatefulPaneHost state={{ kind: 'running', runId: 'run-dismiss' }} />)
    expect(screen.getByTestId('orch-hint')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByTestId('orch-hint')).toBeNull()
  })

  test('overlay does not render when Orchestrator is not running', () => {
    renderPane({ kind: 'starting' })
    expect(screen.queryByTestId('orch-hint')).toBeNull()
  })
})
