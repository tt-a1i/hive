// @vitest-environment jsdom
//
// OrchestratorPane on mobile. The running phone view keeps the PTY slot focused
// and intentionally hides Stop to avoid a destructive fat-finger action.

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import {
  OrchestratorPane,
  type OrchestratorPaneState,
} from '../../web/src/worker/OrchestratorPane.js'
import { renderMobile, renderWide } from './helpers/mobile-render.js'

afterEach(() => {
  cleanup()
})

const withI18n = (ui: React.ReactElement) => <I18nProvider>{ui}</I18nProvider>

const runningState: OrchestratorPaneState = {
  hasUserInputSinceStart: true,
  kind: 'running',
  runId: 'run-orch-1',
  startupBlockedReason: null,
}

const renderPane = (variant: 'mobile' | 'wide', state: OrchestratorPaneState) => {
  const onStart = vi.fn()
  const onRestart = vi.fn()
  const onRemoveWorkspace = vi.fn()
  const renderer = variant === 'mobile' ? renderMobile : renderWide
  renderer(
    withI18n(
      <OrchestratorPane
        state={state}
        onStart={onStart}
        onRestart={onRestart}
        onRemoveWorkspace={onRemoveWorkspace}
      />
    )
  )
  return { onRemoveWorkspace, onRestart, onStart }
}

describe('mobile OrchestratorPane', () => {
  test('running: the PTY slot mounts so the live xterm re-parks there', () => {
    renderPane('mobile', runningState)
    const slot = document.getElementById('orch-pty-run-orch-1')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('orchestrator')
  })

  test('running: Stop is hidden on mobile', () => {
    renderPane('mobile', runningState)
    expect(screen.queryByTestId('orchestrator-stop')).toBeNull()
  })

  test('desktop: Stop is also hidden', () => {
    renderPane('wide', runningState)
    expect(screen.queryByTestId('orchestrator-stop')).toBeNull()
  })

  test('running: mobile does not expose the desktop Stop tap target', () => {
    renderPane('mobile', runningState)
    expect(screen.queryByTestId('orchestrator-stop')).toBeNull()
  })

  test('stopped: the Start CTA is reachable + fires onStart on mobile', () => {
    const { onStart } = renderPane('mobile', { kind: 'stopped' })
    fireEvent.click(screen.getByTestId('orchestrator-start'))
    expect(onStart).toHaveBeenCalledTimes(1)
  })
})
