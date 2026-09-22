// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { Switch } from '../../web/src/ui/Switch.js'

afterEach(cleanup)

describe('settings Switch accessibility and interaction', () => {
  test('exposes switch semantics and changes exactly once per activation', () => {
    const onChange = vi.fn()
    render(<Switch aria-label="工作流" checked={false} onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: '工作流' })

    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toHaveAttribute('type', 'button')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(true)
  })

  test('retains disabled state and does not toggle', () => {
    const onChange = vi.fn()
    render(<Switch aria-label="远程访问" checked disabled onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: '远程访问' })

    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
  })
})
