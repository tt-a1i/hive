import { describe, expect, test } from 'vitest'

import { inferPriorityTag } from '../../src/server/routes-team.js'

describe('inferPriorityTag', () => {
  test('explicit priority=failed returns [FAILED]', () => {
    expect(inferPriorityTag('failed', 'all good')).toBe('[FAILED]')
  })

  test('explicit priority=blocked returns [BLOCKED]', () => {
    expect(inferPriorityTag('blocked', 'all good')).toBe('[BLOCKED]')
  })

  test('explicit priority=normal returns null even if text has keywords', () => {
    expect(inferPriorityTag('normal', 'task failed miserably')).toBeNull()
  })

  test('no priority + text with "failed" keyword → [FAILED] fallback', () => {
    expect(inferPriorityTag(undefined, 'compilation failed with 3 errors')).toBe('[FAILED]')
  })

  test('no priority + text with "blocked" keyword → [FAILED] fallback', () => {
    expect(inferPriorityTag(undefined, 'blocked by upstream dependency')).toBe('[FAILED]')
  })

  test('no priority + text with "error" keyword → [FAILED] fallback', () => {
    expect(inferPriorityTag(undefined, 'runtime error in module X')).toBe('[FAILED]')
  })

  test('no priority + normal text → null (no tag)', () => {
    expect(inferPriorityTag(undefined, 'task completed successfully')).toBeNull()
  })

  test('no priority + text with "error" as substring (e.g. "errorhandling") → NOT matched (word boundary)', () => {
    expect(inferPriorityTag(undefined, 'improved errorhandling logic')).toBeNull()
  })
})
