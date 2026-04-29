// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { RoleAvatar } from '../../web/src/worker/RoleAvatar.js'

afterEach(() => cleanup())

// `role` here is a domain prop on RoleAvatar (worker role: coder/reviewer/…),
// not an HTML ARIA role attribute. biome's useValidAriaRole misfires on the
// JSX attribute name; suppress per-call.

describe('RoleAvatar', () => {
  test.each([
    ['coder', 'Co'],
    ['reviewer', 'Re'],
    ['tester', 'Te'],
    ['custom', 'Cu'],
    ['orchestrator', 'Or'],
  ])('role=%s renders initials %s', (role, expected) => {
    render(<RoleAvatar role={role as never} />)
    expect(screen.getByTestId('role-avatar').textContent).toBe(expected)
  })

  test('data-role attribute reflects role for theming', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    render(<RoleAvatar role="coder" />)
    expect(screen.getByTestId('role-avatar').getAttribute('data-role')).toBe('coder')
  })

  test('size prop controls width + height + scaled fontSize together', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    render(<RoleAvatar role="coder" size={40} />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.width).toBe('40px')
    expect(el.style.height).toBe('40px')
    // initials size scales with avatar size; spec §4.4 specifies a proportional
    // glyph that reads at any size — 40 * 0.34 = 13.6 → rounds to 14.
    expect(el.style.fontSize).toBe('14px')
  })

  test('default size is 32px — width + height + 11px font', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    render(<RoleAvatar role="coder" />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.width).toBe('32px')
    expect(el.style.height).toBe('32px')
    expect(el.style.fontSize).toBe('11px')
  })

  test('background and border are derived from role color (status-blue for coder)', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    render(<RoleAvatar role="coder" />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.color).toBe('var(--status-blue)')
    expect(el.style.background).toContain('var(--status-blue)')
    // border is a shorthand string ("1px solid color-mix(...)"); jsdom doesn't
    // decompose it into borderColor, so assert the raw style attribute.
    expect(el.getAttribute('style') ?? '').toContain('var(--status-blue) 35%')
  })

  test('reviewer uses purple, tester uses orange — palette per spec §4.4', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    const { rerender } = render(<RoleAvatar role="reviewer" />)
    expect(screen.getByTestId('role-avatar').style.color).toBe('var(--status-purple)')
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    rerender(<RoleAvatar role="tester" />)
    expect(screen.getByTestId('role-avatar').style.color).toBe('var(--status-orange)')
  })
})
