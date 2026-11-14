import { describe, expect, test } from 'vitest'

import { buildDispatchMessagePayload } from '../../src/server/dispatch-message-payload.js'
import type { DispatchMessageRecord } from '../../src/shared/team-collaboration.js'

const message = (overrides: Partial<DispatchMessageRecord> = {}): DispatchMessageRecord => ({
  createdAt: 1,
  deliveredAt: null,
  deliveryError: null,
  deliveryState: 'delivering',
  dispatchId: 'd1',
  fromAgentId: 'ws:orchestrator',
  id: 'm1',
  kind: 'note',
  recipientAgentId: 'worker-1',
  replyTo: null,
  sequence: 2,
  sourceDispatchId: null,
  text: 'please also cover logout',
  workspaceId: 'ws',
  ...overrides,
})

describe('buildDispatchMessagePayload', () => {
  test('emits a single-line inline envelope (<= 400 chars) for short messages and interpolates N into --seen advice for workers', () => {
    const payload = buildDispatchMessagePayload(message(), 2)
    expect(payload).not.toMatch(/[\r\n]/)
    expect(payload.length).toBeLessThanOrEqual(400)
    expect(payload.startsWith('<hive-message kind="note" message="m1" dispatch="d1">')).toBe(true)
    expect(payload).toContain('required_seen_seq: 2')
    expect(payload).toContain('use `--seen 2`')
    expect(payload).toContain('team messages --dispatch d1')
  })

  test('omits required_seen_seq when 0 or when the recipient is the orchestrator', () => {
    const toOrch = buildDispatchMessagePayload(
      message({ kind: 'question', fromAgentId: 'worker-1', recipientAgentId: 'ws:orchestrator' }),
      2
    )
    expect(toOrch).not.toMatch(/[\r\n]/)
    expect(toOrch.length).toBeLessThanOrEqual(400)
    expect(toOrch).not.toContain('required_seen_seq:')
    expect(toOrch).not.toContain('--seen')
    expect(toOrch).toContain('please also cover logout')
    expect(toOrch).toContain('team reply m1 --stdin')

    const zeroWatermark = buildDispatchMessagePayload(message(), 0)
    expect(zeroWatermark).not.toContain('required_seen_seq:')
    expect(zeroWatermark).not.toContain('--seen')
  })

  test('falls back to multiline envelope for multiline or long messages while retaining required_seen_seq', () => {
    const payload = buildDispatchMessagePayload(
      message({ kind: 'question', sequence: 3, text: 'question line 1\nquestion line 2' }),
      3
    )
    expect(payload).toContain('\n')
    expect(payload.split('\n')[0]).toBe('<hive-message kind="question" message="m1" dispatch="d1">')
    expect(payload).toContain('required_seen_seq: 3')
    expect(payload).toContain('use `--seen 3`')
  })
})
