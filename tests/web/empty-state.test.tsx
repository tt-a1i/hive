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
    render(<EmptyState title="t" description="d" icon={<svg data-testid="custom-icon" />} />)
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument()
  })

  test('renders slots in DOM order: icon → title → description', () => {
    render(
      <EmptyState title="My title" description="My desc" icon={<svg data-testid="my-icon" />} />
    )
    const root = screen.getByTestId('empty-state')
    const order = Array.from(root.children).map((child) => child.getAttribute('data-testid'))
    const iconIdx = order.indexOf('empty-state-icon')
    const titleIdx = order.indexOf('empty-state-title')
    const descIdx = order.indexOf('empty-state-description')
    expect(iconIdx).toBeGreaterThanOrEqual(0)
    expect(iconIdx).toBeLessThan(titleIdx)
    expect(titleIdx).toBeLessThan(descIdx)
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
