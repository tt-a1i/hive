// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { Confirm } from '../../web/src/ui/Confirm.js'

afterEach(() => cleanup())

describe('Confirm dialog', () => {
  test('renders when open=true; click confirm calls onConfirm and closes', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <Confirm
        open
        onOpenChange={onOpenChange}
        title="Stop Queen?"
        description="The PTY will be killed."
        confirmLabel="Stop"
        onConfirm={onConfirm}
      />
    )
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Stop Queen?')
    expect(screen.getByTestId('confirm-description')).toHaveTextContent('The PTY will be killed.')

    fireEvent.click(screen.getByTestId('confirm-action'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('cancel button calls onOpenChange(false), not onConfirm', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <Confirm
        open
        onOpenChange={onOpenChange}
        title="t"
        description="d"
        confirmLabel="OK"
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByTestId('confirm-cancel'))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('open=false does not render dialog content', () => {
    render(
      <Confirm
        open={false}
        onOpenChange={() => {}}
        title="t"
        description="d"
        confirmLabel="OK"
        onConfirm={() => {}}
      />
    )
    expect(screen.queryByTestId('confirm-title')).toBeNull()
  })

  test('confirmKind=danger applies danger styling on action button', () => {
    render(
      <Confirm
        open
        onOpenChange={() => {}}
        title="t"
        description="d"
        confirmLabel="Delete"
        confirmKind="danger"
        onConfirm={() => {}}
      />
    )
    expect(screen.getByTestId('confirm-action').className).toContain('icon-btn--danger')
  })
})
