// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { EmptyState } from '../../web/src/ui/EmptyState.js'

afterEach(() => cleanup())

describe('EmptyState', () => {
  test('renders title + description, no action when not provided', () => {
    render(<EmptyState title="No workspaces" description="Add one to start" />)
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('No workspaces')
    expect(screen.getByTestId('empty-state-description')).toHaveTextContent('Add one to start')
    expect(screen.queryByTestId('empty-state-action')).toBeNull()
  })

  test('renders icon slot when provided', () => {
    render(
      <EmptyState
        title="t"
        description="d"
        icon={<svg data-testid="custom-icon" />}
      />
    )
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument()
  })

  test('renders action and triggers click', () => {
    const onClick = vi.fn()
    render(
      <EmptyState
        title="t"
        description="d"
        action={
          <button type="button" data-testid="empty-state-action" onClick={onClick}>
            Add
          </button>
        }
      />
    )
    fireEvent.click(screen.getByTestId('empty-state-action'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
