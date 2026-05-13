// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { OrchestratorHintOverlay } from '../../web/src/worker/OrchestratorHintOverlay.js'

afterEach(() => cleanup())

test('hint overlay is visible when no input has been sent yet', () => {
  render(<OrchestratorHintOverlay visible onDismiss={() => {}} />)
  expect(screen.getByTestId('orch-hint')).toBeInTheDocument()
  expect(screen.getByText(/try saying/i)).toBeInTheDocument()
})

test('hint overlay unmounts when visible flips false', () => {
  const { rerender } = render(<OrchestratorHintOverlay visible onDismiss={() => {}} />)
  expect(screen.getByTestId('orch-hint')).toBeInTheDocument()
  rerender(<OrchestratorHintOverlay visible={false} onDismiss={() => {}} />)
  expect(screen.queryByTestId('orch-hint')).toBeNull()
})

test('Dismiss button fires onDismiss', () => {
  const onDismiss = vi.fn()
  render(<OrchestratorHintOverlay visible onDismiss={onDismiss} />)
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
  expect(onDismiss).toHaveBeenCalledOnce()
})
