import { describe, expect, test } from 'vitest'

import { parseTaskMetadata } from '../../web/src/tasks/task-meta.js'

describe('parseTaskMetadata', () => {
  test('returns the text unchanged when there is no trailing block', () => {
    const { title, meta } = parseTaskMetadata('**T1 project review**')
    expect(title).toBe('**T1 project review**')
    expect(meta).toEqual([])
  })

  test('splits a single owner + status block on the typical orchestrator format', () => {
    const { title, meta } = parseTaskMetadata(
      '**T1 项目评估** (owner: pixel-beacon-10, status: done · 报告: docs/eval-report.md · 129 tests passed)'
    )
    expect(title).toBe('**T1 项目评估**')
    expect(meta).toEqual([
      { kind: 'owner', value: 'pixel-beacon-10' },
      { kind: 'status', value: 'done', tone: 'green' },
      { kind: 'path', label: '报告', value: 'docs/eval-report.md' },
      { kind: 'note', value: '129 tests passed' },
    ])
  })

  test('maps a non-English status word to the matching tone', () => {
    const { meta } = parseTaskMetadata('**T2** (status: 派单)')
    expect(meta).toEqual([{ kind: 'status', value: '派单', tone: 'orange' }])
  })

  test('routes unknown status words to neutral so they still render', () => {
    const { meta } = parseTaskMetadata('**T3** (status: pondering)')
    expect(meta).toEqual([{ kind: 'status', value: 'pondering', tone: 'neutral' }])
  })

  test('detects path values without an explicit path key', () => {
    const { meta } = parseTaskMetadata('**T4** (artifact: notes/summary.md)')
    expect(meta).toEqual([{ kind: 'path', label: 'artifact', value: 'notes/summary.md' }])
  })

  test('falls back to a plain note when nothing fits', () => {
    const { meta } = parseTaskMetadata('**T5** (depends on T1)')
    expect(meta).toEqual([{ kind: 'note', value: 'depends on T1' }])
  })

  test('handles a trailing ()  with no body without crashing', () => {
    const { title, meta } = parseTaskMetadata('**T6** ()')
    expect(title).toBe('**T6** ()')
    expect(meta).toEqual([])
  })
})
