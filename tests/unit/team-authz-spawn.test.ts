import { describe, expect, test } from 'vitest'

import { commandAllowedForRole } from '../../src/server/team-authz.js'

describe('team authz — spawn/dismiss', () => {
  test('orchestrator may spawn and dismiss', () => {
    expect(commandAllowedForRole('orchestrator', 'spawn')).toBe(true)
    expect(commandAllowedForRole('orchestrator', 'dismiss')).toBe(true)
  })

  test('workers may not spawn or dismiss', () => {
    expect(commandAllowedForRole('coder', 'spawn')).toBe(false)
    expect(commandAllowedForRole('reviewer', 'dismiss')).toBe(false)
  })

  test('the workflow pseudo-role may not spawn or dismiss', () => {
    expect(commandAllowedForRole('workflow', 'spawn')).toBe(false)
    expect(commandAllowedForRole('workflow', 'dismiss')).toBe(false)
  })
})
