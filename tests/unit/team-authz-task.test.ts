import { describe, expect, test } from 'vitest'

import { commandAllowedForRole } from '../../src/server/team-authz.js'

describe('team-authz task command', () => {
  test('orchestrator can execute task command', () => {
    expect(commandAllowedForRole('orchestrator', 'task')).toBe(true)
  })

  test('worker roles can execute task command (authz pass-through)', () => {
    expect(commandAllowedForRole('coder', 'task')).toBe(true)
    expect(commandAllowedForRole('reviewer', 'task')).toBe(true)
    expect(commandAllowedForRole('tester', 'task')).toBe(true)
    expect(commandAllowedForRole('custom', 'task')).toBe(true)
  })

  test('orchestrator retains all other allowed commands', () => {
    expect(commandAllowedForRole('orchestrator', 'send')).toBe(true)
    expect(commandAllowedForRole('orchestrator', 'list')).toBe(true)
    expect(commandAllowedForRole('orchestrator', 'cancel')).toBe(true)
    expect(commandAllowedForRole('orchestrator', 'help')).toBe(true)
    expect(commandAllowedForRole('orchestrator', 'discuss')).toBe(true)
  })

  test('worker retains all other allowed commands', () => {
    expect(commandAllowedForRole('coder', 'report')).toBe(true)
    expect(commandAllowedForRole('coder', 'status')).toBe(true)
    expect(commandAllowedForRole('coder', 'help')).toBe(true)
    expect(commandAllowedForRole('coder', 'discuss')).toBe(true)
  })

  test('worker cannot execute orchestrator-only commands', () => {
    expect(commandAllowedForRole('coder', 'send')).toBe(false)
    expect(commandAllowedForRole('coder', 'cancel')).toBe(false)
    expect(commandAllowedForRole('coder', 'list')).toBe(false)
  })

  test('orchestrator cannot execute worker-only commands', () => {
    expect(commandAllowedForRole('orchestrator', 'report')).toBe(false)
    expect(commandAllowedForRole('orchestrator', 'status')).toBe(false)
  })
})
