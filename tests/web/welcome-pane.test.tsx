// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { WelcomePane } from '../../web/src/worker/WelcomePane.js'

afterEach(() => cleanup())

test('WelcomePane renders 3-step guide and fires onAddWorkspace from CTA', () => {
  const onAdd = vi.fn()
  render(<WelcomePane onAddWorkspace={onAdd} />)
  expect(screen.getByText(/add a workspace/i)).toBeInTheDocument()
  expect(screen.getByText(/choose an orchestrator/i)).toBeInTheDocument()
  expect(screen.getByText(/dispatch tasks/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /add your first workspace/i }))
  expect(onAdd).toHaveBeenCalledOnce()
})

test('WelcomePane stays within max-width so it does not stretch absurdly on wide monitors', () => {
  const { container } = render(<WelcomePane onAddWorkspace={() => {}} />)
  const card = container.querySelector('[data-testid="welcome-pane"]') as HTMLElement
  expect(card).toHaveStyle({ maxWidth: '540px' })
})

test('WelcomePane "Try Demo" link is absent when onTryDemo is not provided', () => {
  render(<WelcomePane onAddWorkspace={() => {}} />)
  expect(screen.queryByRole('button', { name: /try demo/i })).toBeNull()
})

test('WelcomePane "Try Demo" button fires onTryDemo', () => {
  const onDemo = vi.fn()
  render(<WelcomePane onAddWorkspace={() => {}} onTryDemo={onDemo} />)
  fireEvent.click(screen.getByRole('button', { name: /try the demo/i }))
  expect(onDemo).toHaveBeenCalledOnce()
})
