// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { RoleAvatar } from '../../web/src/worker/RoleAvatar.js'

afterEach(() => cleanup())

// `role` here is a domain prop on RoleAvatar (worker role: coder/reviewer/…),
// not an HTML ARIA role attribute. biome's useValidAriaRole misfires on the
// JSX attribute name; suppress per-call where the value is a string literal.

describe('RoleAvatar', () => {
  test.each([
    ['coder', 'code'],
    ['reviewer', 'review'],
    ['tester', 'test'],
    ['custom', 'custom'],
    ['orchestrator', 'crown'],
  ])('role=%s renders its own glyph (data-icon=%s) as an svg', (role, icon) => {
    render(<RoleAvatar role={role as never} />)
    const el = screen.getByTestId('role-avatar')
    // Each role maps to a distinct lucide glyph. Asserting the stable
    // `data-icon` marker (not lucide's churny SVG class names) catches a wrong
    // or duplicated mapping; the <svg> check catches "glyph dropped entirely".
    expect(el.getAttribute('data-icon')).toBe(icon)
    expect(el.querySelector('svg')).not.toBeNull()
    // The old two-letter initials (Co/Re/…) are gone — no text content left.
    expect(el.textContent).toBe('')
  })

  test('data-role attribute reflects role for theming', () => {
    // biome-ignore lint/a11y/useValidAriaRole: domain prop, not HTML role
    render(<RoleAvatar role="coder" />)
    expect(screen.getByTestId('role-avatar').getAttribute('data-role')).toBe('coder')
  })
})
