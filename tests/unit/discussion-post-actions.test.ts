import { describe, expect, it } from 'vitest'

import { parseNextActions } from '../../src/server/discussion-post-actions.js'

describe('parseNextActions', () => {
  it('should parse "## 4. Next Actions" section (not only ## 5.)', () => {
    const report = `## 3. Summary
Some summary here.

## 4. Next Actions
- Implement the new API endpoint
- Write integration tests
- Update documentation

## 5. References
Some refs.`

    const result = parseNextActions(report)
    expect(result).toEqual([
      'Implement the new API endpoint',
      'Write integration tests',
      'Update documentation',
    ])
  })

  it('should parse "* item" format lists', () => {
    const report = `## 5. Next Actions
* Fix the broken test
* Deploy to staging
* Notify the team`

    const result = parseNextActions(report)
    expect(result).toEqual([
      'Fix the broken test',
      'Deploy to staging',
      'Notify the team',
    ])
  })

  it('should return empty array for empty report without error', () => {
    expect(parseNextActions('')).toEqual([])
  })

  it('should return empty array when no Next Actions section exists', () => {
    const report = `## 1. Overview
Just some text.

## 2. Conclusion
Done.`

    expect(parseNextActions(report)).toEqual([])
  })

  it('should parse numbered list items (1. item)', () => {
    const report = `## 3. Next Actions
1. First action
2. Second action
3. Third action

## 4. Notes`

    const result = parseNextActions(report)
    expect(result).toEqual([
      'First action',
      'Second action',
      'Third action',
    ])
  })
})
