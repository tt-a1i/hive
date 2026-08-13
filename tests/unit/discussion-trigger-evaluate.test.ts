import { describe, expect, it } from 'vitest'

import { type DiscussionTriggerRule, evaluateTrigger } from '../../src/server/discussion-templates.js'

describe('evaluateTrigger', () => {
  const reviewRule: DiscussionTriggerRule = {
    condition: 'task_needs_review',
    description: 'needs review',
  }

  const riskRule: DiscussionTriggerRule = {
    condition: 'task_is_high_risk',
    min_workers: 3,
    description: 'high risk',
  }

  it('should NOT match "approve" keyword inside unrelated word "disapprove"', () => {
    const result = evaluateTrigger('I disapprove of this approach', [reviewRule])
    expect(result).toEqual([])
  })

  it('should NOT match "check" inside "error handling completed"', () => {
    const result = evaluateTrigger('error handling completed', [reviewRule])
    expect(result).toEqual([])
  })

  it('should NOT trigger when min_workers requirement is not met', () => {
    const result = evaluateTrigger('this is a risky production deploy', [riskRule], 2)
    expect(result).toEqual([])
  })

  it('should match exact word "approve" when standalone', () => {
    const result = evaluateTrigger('please approve this change', [reviewRule])
    expect(result).toHaveLength(1)
  })

  it('should match exact word "risk" when standalone', () => {
    const ruleNoMin: DiscussionTriggerRule = {
      condition: 'task_is_high_risk',
      description: 'high risk',
    }
    const result = evaluateTrigger('this has significant risk', [ruleNoMin])
    expect(result).toHaveLength(1)
  })
})
