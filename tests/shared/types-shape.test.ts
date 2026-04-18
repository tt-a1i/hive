import { describe, expect, test } from 'vitest'
import type { AgentStatus, TeamListItem } from '../../src/shared/types.js'
import { agentStatuses } from '../../src/shared/types.js'

describe('shared types contract', () => {
  test('shared types module exports runtime contract markers', () => {
    expect(agentStatuses).toEqual(['idle', 'working', 'stopped'])
  })

  test('team list item status uses three-state model', () => {
    const item: TeamListItem = {
      id: 'alice',
      name: 'Alice',
      role: 'coder',
      status: 'working' satisfies AgentStatus,
      pendingTaskCount: 1,
    }

    expect(item.status).toBe('working')
    expect(item.pendingTaskCount).toBe(1)
  })
})
