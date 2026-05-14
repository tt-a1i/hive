// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { deriveInitial, pickWorkspaceColor } from '../../web/src/sidebar/derive-workspace-color.js'
import { WorkspaceAvatar } from '../../web/src/sidebar/WorkspaceAvatar.js'

afterEach(() => cleanup())

describe('deriveInitial', () => {
  test('returns the first letter uppercased', () => {
    expect(deriveInitial('insights')).toBe('I')
    expect(deriveInitial('hive')).toBe('H')
  })

  test('preserves non-latin first codepoints', () => {
    expect(deriveInitial('蜂巢')).toBe('蜂')
  })

  test('trims leading whitespace', () => {
    expect(deriveInitial('  my-todo  ')).toBe('M')
  })

  test('falls back to "?" on empty input', () => {
    expect(deriveInitial('')).toBe('?')
    expect(deriveInitial('   ')).toBe('?')
  })
})

describe('pickWorkspaceColor', () => {
  test('is deterministic for the same id', () => {
    expect(pickWorkspaceColor('workspace-abc').token).toBe(
      pickWorkspaceColor('workspace-abc').token
    )
  })

  test('produces at least two distinct colors across eight ids (reversibility check)', () => {
    // If hashing collapses to a constant index the implementation is broken;
    // testing 8 ids guards against trivially-passing assertions.
    const labels = new Set(Array.from({ length: 8 }, (_, i) => pickWorkspaceColor(`ws-${i}`).label))
    expect(labels.size).toBeGreaterThanOrEqual(2)
  })
})

describe('WorkspaceAvatar', () => {
  test('renders the derived initial', () => {
    render(<WorkspaceAvatar workspaceId="w1" name="insights" isActive={false} />)
    expect(screen.getByTestId('workspace-avatar')).toHaveTextContent('I')
  })

  test('toggles data-active to expose the ring outline', () => {
    const { rerender } = render(<WorkspaceAvatar workspaceId="w2" name="x" isActive={false} />)
    expect(screen.getByTestId('workspace-avatar').getAttribute('data-active')).toBeNull()
    rerender(<WorkspaceAvatar workspaceId="w2" name="x" isActive />)
    expect(screen.getByTestId('workspace-avatar').getAttribute('data-active')).toBe('true')
  })

  test('renders status-dot--working only when the working flag is set', () => {
    const { rerender } = render(<WorkspaceAvatar workspaceId="w3" name="x" isActive={false} />)
    expect(screen.getByTestId('workspace-avatar').querySelector('.status-dot--working')).toBeNull()
    rerender(<WorkspaceAvatar workspaceId="w3" name="x" isActive={false} working />)
    expect(
      screen.getByTestId('workspace-avatar').querySelector('.status-dot--working')
    ).not.toBeNull()
  })

  test('same workspaceId produces a stable inline style across renders', () => {
    const { container } = render(
      <div>
        <WorkspaceAvatar workspaceId="stable" name="x" isActive={false} />
        <WorkspaceAvatar workspaceId="stable" name="y" isActive={false} />
      </div>
    )
    const avatars = container.querySelectorAll('[data-testid="workspace-avatar"]')
    expect(avatars).toHaveLength(2)
    expect(avatars[0]?.getAttribute('data-color-label')).toBe(
      avatars[1]?.getAttribute('data-color-label')
    )
  })
})
