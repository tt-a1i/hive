// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { RoleAvatar } from '../../web/src/worker/RoleAvatar.js'

afterEach(() => cleanup())

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
    render(<RoleAvatar role="coder" />)
    expect(screen.getByTestId('role-avatar').getAttribute('data-role')).toBe('coder')
  })

  test('size prop controls width/height', () => {
    render(<RoleAvatar role="coder" size={40} />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.width).toBe('40px')
    expect(el.style.height).toBe('40px')
  })

  test('default size is 32px', () => {
    render(<RoleAvatar role="coder" />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.width).toBe('32px')
  })
})
