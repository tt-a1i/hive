import { expect, test } from 'vitest'
import { agentStatuses } from '../../src/shared/types.js'

test('agent statuses expose the three-state runtime contract', () => {
  expect(agentStatuses).toEqual(['idle', 'working', 'stopped'])
})
