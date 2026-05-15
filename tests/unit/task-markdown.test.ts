import { describe, expect, test } from 'vitest'

import {
  appendChildTaskAtLine,
  deleteTaskLine,
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
})
