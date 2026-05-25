import { describe, expect, test } from 'vitest'

import { findTaskByTitle, injectAnchor, parseAnchors } from '../../src/server/task-anchor.js'

describe('parseAnchors', () => {
  test('extracts anchors from lines', () => {
    const content = [
      '- [ ] First task <!-- tid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee -->',
      '- [ ] No anchor here',
      '- [x] Done task <!-- tid:11111111-2222-3333-4444-555555555555 -->',
    ].join('\n')
    const result = parseAnchors(content)
    expect(result.size).toBe(2)
    expect(result.get(0)).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(result.get(2)).toBe('11111111-2222-3333-4444-555555555555')
    expect(result.has(1)).toBe(false)
  })

  test('returns empty map for no anchors', () => {
    expect(parseAnchors('- [ ] foo\n- [ ] bar').size).toBe(0)
  })

  test('skips malformed anchors gracefully', () => {
    const content = [
      '- [ ] Bad <!-- tid:not-a-uuid -->',
      '- [ ] Also bad <!-- tid: -->',
      '- [ ] Good <!-- tid:aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee -->',
    ].join('\n')
    const result = parseAnchors(content)
    expect(result.size).toBe(1)
    expect(result.get(2)).toBe('aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee')
  })
})

describe('injectAnchor', () => {
  test('appends anchor to specified line', () => {
    const content = '- [ ] First\n- [ ] Second\n- [ ] Third'
    const result = injectAnchor(content, 1, 'aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee')
    const lines = result.split('\n')
    expect(lines[1]).toBe('- [ ] Second <!-- tid:aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee -->')
    expect(lines[0]).toBe('- [ ] First')
    expect(lines[2]).toBe('- [ ] Third')
  })

  test('returns content unchanged for out-of-bounds index', () => {
    const content = '- [ ] Only line'
    expect(injectAnchor(content, 5, 'aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee')).toBe(content)
    expect(injectAnchor(content, -1, 'aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee')).toBe(content)
  })
})

describe('findTaskByTitle', () => {
  const content = [
    '## Section',
    '- [ ] Fix the login bug (@bob) <!-- tid:aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee -->',
    '- [ ] Add tests (priority: high)',
    '- [x] Deploy v2',
  ].join('\n')

  test('finds task by normalized title', () => {
    const result = findTaskByTitle(content, 'Fix the login bug')
    expect(result).toEqual({ lineIndex: 1, existingAnchor: 'aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee' })
  })

  test('matches ignoring metadata parentheticals and @mentions', () => {
    const result = findTaskByTitle(content, 'Add tests')
    expect(result).toEqual({ lineIndex: 2 })
  })

  test('matches completed tasks', () => {
    const result = findTaskByTitle(content, 'Deploy v2')
    expect(result).toEqual({ lineIndex: 3 })
  })

  test('returns null for non-matching title', () => {
    expect(findTaskByTitle(content, 'Nonexistent task')).toBeNull()
  })

  test('returns null for empty title', () => {
    expect(findTaskByTitle(content, '')).toBeNull()
  })

  test('skips non-task lines', () => {
    expect(findTaskByTitle(content, 'Section')).toBeNull()
  })
})
