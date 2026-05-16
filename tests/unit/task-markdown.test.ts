import { describe, expect, test } from 'vitest'

import {
  appendChildTaskAtLine,
  countDirectCheckboxChildren,
  deleteTaskLine,
  parseTaskMarkdown,
  updateTaskTextAtLine,
} from '../../web/src/tasks/task-markdown.js'

describe('updateTaskTextAtLine', () => {
  test('rewrites only the target line and keeps the checkbox state', () => {
    const content = '- [ ] alpha\n- [x] beta\n'
    expect(updateTaskTextAtLine(content, 1, 'beta v2')).toBe('- [ ] alpha\n- [x] beta v2\n')
  })

  test('preserves indentation of nested tasks', () => {
    const content = '- [ ] parent\n  - [ ] child\n'
    expect(updateTaskTextAtLine(content, 1, 'renamed child')).toBe(
      '- [ ] parent\n  - [ ] renamed child\n'
    )
  })

  test('ignores empty new text (returns original)', () => {
    const content = '- [ ] alpha\n'
    expect(updateTaskTextAtLine(content, 0, '   ')).toBe(content)
  })

  test('ignores indices that do not point at a task line', () => {
    const content = 'free prose\n- [ ] alpha\n'
    expect(updateTaskTextAtLine(content, 0, 'nope')).toBe(content)
  })

  test('collapses embedded newlines so a pasted multi-line value stays on one row', () => {
    const content = '- [ ] alpha\n'
    expect(updateTaskTextAtLine(content, 0, 'first line\nsecond line')).toBe(
      '- [ ] first line second line\n'
    )
  })
})

describe('deleteTaskLine', () => {
  test('drops the line at the index and leaves siblings intact', () => {
    const content = '- [ ] alpha\n- [ ] beta\n- [ ] gamma\n'
    expect(deleteTaskLine(content, 1)).toBe('- [ ] alpha\n- [ ] gamma\n')
  })

  test('cascades into nested children deeper than the deleted line', () => {
    const content =
      '- [ ] parent\n  - [ ] child A\n    - [ ] grandchild\n  - [ ] child B\n- [ ] sibling\n'
    expect(deleteTaskLine(content, 0)).toBe('- [ ] sibling\n')
  })

  test('stops cascading at a peer of the same indent', () => {
    const content = '- [ ] one\n  - [ ] one-child\n- [ ] two\n'
    expect(deleteTaskLine(content, 0)).toBe('- [ ] two\n')
  })

  test('returns content unchanged when the index is not a task line', () => {
    const content = '# heading\n- [ ] task\n'
    expect(deleteTaskLine(content, 0)).toBe(content)
  })
})

describe('appendChildTaskAtLine', () => {
  test('inserts a new child directly under the parent', () => {
    const content = '- [ ] parent\n- [ ] sibling\n'
    expect(appendChildTaskAtLine(content, 0, 'new-child')).toBe(
      '- [ ] parent\n  - [ ] new-child\n- [ ] sibling\n'
    )
  })

  test('inserts after existing children so the new task ends up last in the subtree', () => {
    const content = '- [ ] parent\n  - [ ] child A\n  - [ ] child B\n- [ ] sibling\n'
    expect(appendChildTaskAtLine(content, 0, 'child C')).toBe(
      '- [ ] parent\n  - [ ] child A\n  - [ ] child B\n  - [ ] child C\n- [ ] sibling\n'
    )
  })

  test('two-space indents the child relative to a nested parent', () => {
    const content = '- [ ] root\n  - [ ] parent\n'
    expect(appendChildTaskAtLine(content, 1, 'new')).toBe(
      '- [ ] root\n  - [ ] parent\n    - [ ] new\n'
    )
  })

  test('does nothing when the index does not point at a task line', () => {
    const content = 'prose\n- [ ] one\n'
    expect(appendChildTaskAtLine(content, 0, 'new')).toBe(content)
  })

  test('returns content unchanged when text is empty', () => {
    const content = '- [ ] parent\n'
    expect(appendChildTaskAtLine(content, 0, '   ')).toBe(content)
  })

  test('collapses embedded newlines in the new child text', () => {
    const content = '- [ ] parent\n'
    expect(appendChildTaskAtLine(content, 0, 'line one\nline two')).toBe(
      '- [ ] parent\n  - [ ] line one line two\n'
    )
  })
})

describe('parseTaskMarkdown — legacy (no whitelist)', () => {
  test('extracts a top-level task with one @mention and strips it from text', () => {
    const [task] = parseTaskMarkdown('- [ ] implement login @Alice\n')
    expect(task?.mentions).toEqual(['@Alice'])
    expect(task?.text).toBe('implement login')
    expect(task?.checked).toBe(false)
  })

  test('does not treat mid-word @ as a mention (email is not a chip)', () => {
    const [task] = parseTaskMarkdown('- [ ] ping email@example.com today\n')
    expect(task?.mentions).toEqual([])
    expect(task?.text).toBe('ping email@example.com today')
  })

  test('nests children by indent, two spaces deep', () => {
    const [parent] = parseTaskMarkdown('- [ ] parent\n  - [x] child A\n  - [ ] child B\n')
    expect(parent?.children).toHaveLength(2)
    expect(parent?.children[0]?.checked).toBe(true)
    expect(parent?.children[1]?.text).toBe('child B')
  })

  test('child task does not inherit the parent mention (per-task only)', () => {
    const [parent] = parseTaskMarkdown('- [ ] parent @Alice\n  - [ ] no-mention child\n')
    expect(parent?.mentions).toEqual(['@Alice'])
    expect(parent?.children[0]?.mentions).toEqual([])
  })
})

describe('parseTaskMarkdown — fail-soft (with knownWorkerNames)', () => {
  test('keeps only mentions that match the workspace worker roster (case-insensitive)', () => {
    const [task] = parseTaskMarkdown('- [ ] handoff to @alice and @Unknown\n', {
      knownWorkerNames: ['Alice', 'Bob'],
    })
    expect(task?.mentions).toEqual(['@Alice'])
    // Unknown stays visible in body text — we don't silently strip it like a real chip.
    expect(task?.text).toContain('@Unknown')
  })

  test('still rejects mid-word @ even when worker name happens to appear in an email', () => {
    const [task] = parseTaskMarkdown('- [ ] write to alice@example.com about it\n', {
      knownWorkerNames: ['Alice'],
    })
    expect(task?.mentions).toEqual([])
    expect(task?.text).toBe('write to alice@example.com about it')
  })

  test('drops mentions that look like names but aren’t in the roster', () => {
    const [task] = parseTaskMarkdown("- [ ] coordinate with @alice's-task framing\n", {
      knownWorkerNames: ['Bob'],
    })
    expect(task?.mentions).toEqual([])
    expect(task?.text).toContain("@alice's-task")
  })

  test('empty roster collapses to "no mentions allowed" rather than legacy permissive mode', () => {
    const [task] = parseTaskMarkdown('- [ ] @Alice please review\n', { knownWorkerNames: [] })
    expect(task?.mentions).toEqual([])
    expect(task?.text).toContain('@Alice')
  })
})

describe('countDirectCheckboxChildren', () => {
  test('counts only direct checkbox children, not grandchildren', () => {
    const [parent] = parseTaskMarkdown(
      '- [ ] parent\n  - [x] child A\n    - [ ] grandchild not counted\n  - [ ] child B\n'
    )
    if (!parent) throw new Error('expected a parsed parent task')
    expect(countDirectCheckboxChildren(parent)).toEqual({ done: 1, total: 2 })
  })

  test('returns null when there are no children at all (badge should be hidden)', () => {
    const [task] = parseTaskMarkdown('- [ ] standalone\n')
    if (!task) throw new Error('expected a parsed task')
    expect(countDirectCheckboxChildren(task)).toBeNull()
  })

  test('reports total = direct children count regardless of checked-state mix', () => {
    const [parent] = parseTaskMarkdown('- [ ] parent\n  - [x] one\n  - [x] two\n  - [x] three\n')
    if (!parent) throw new Error('expected a parsed parent task')
    expect(countDirectCheckboxChildren(parent)).toEqual({ done: 3, total: 3 })
  })
})
