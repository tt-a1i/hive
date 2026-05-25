import { describe, expect, test } from 'vitest'

import { isFailedReport, isOperationalAlert } from '../../src/server/agent-stdin-dispatcher.js'

describe('isOperationalAlert', () => {
  test('matches structured [TAG] at line start', () => {
    expect(isOperationalAlert('[CRASHED] worker exited unexpectedly')).toBe(true)
    expect(isOperationalAlert('[STOPPED] agent halted')).toBe(true)
    expect(isOperationalAlert('[FAILED] task could not complete')).toBe(true)
    expect(isOperationalAlert('[ERROR] connection refused')).toBe(true)
    expect(isOperationalAlert('[EXPIRED] session timed out')).toBe(true)
    expect(isOperationalAlert('[UNREACHABLE] host not responding')).toBe(true)
  })

  test('matches case-insensitively', () => {
    expect(isOperationalAlert('[failed] something broke')).toBe(true)
    expect(isOperationalAlert('[Error] bad state')).toBe(true)
  })

  test('matches [TAG] on a non-first line (multiline text)', () => {
    expect(isOperationalAlert('some preamble\n[CRASHED] agent died')).toBe(true)
  })

  test('does NOT match bare keywords in normal prose', () => {
    expect(isOperationalAlert('fixed the error in login handler')).toBe(false)
    expect(isOperationalAlert('error handling completed successfully')).toBe(false)
    expect(isOperationalAlert('the process stopped gracefully')).toBe(false)
    expect(isOperationalAlert('task failed validation but was retried')).toBe(false)
    expect(isOperationalAlert('unreachable code removed')).toBe(false)
  })

  test('does NOT match [TAG] in the middle of a line', () => {
    expect(isOperationalAlert('status: [FAILED] see logs')).toBe(false)
  })
})

describe('isFailedReport', () => {
  test('matches structured [TAG] at line start', () => {
    expect(isFailedReport('[FAILED] could not compile')).toBe(true)
    expect(isFailedReport('[BLOCKED] waiting on dependency')).toBe(true)
    expect(isFailedReport('[ERROR] runtime panic')).toBe(true)
  })

  test('does NOT match bare keywords in normal prose', () => {
    expect(isFailedReport('fixed the error')).toBe(false)
    expect(isFailedReport('previously failed test now passes')).toBe(false)
    expect(isFailedReport('unblocked after merge')).toBe(false)
    expect(isFailedReport('错误已修复')).toBe(false)
    expect(isFailedReport('任务失败后重试成功')).toBe(false)
  })

  test('does NOT match tags that are not failure indicators', () => {
    expect(isFailedReport('[STOPPED] graceful shutdown')).toBe(false)
    expect(isFailedReport('[CRASHED] but recovered')).toBe(false)
  })
})

describe('server-injected [TAG] prefix recognized by dispatcher', () => {
  test('server injects [FAILED] prefix for priority=failed → dispatcher detects high priority', () => {
    const reportText = 'task could not complete due to missing dependency'
    const prefixed = `[FAILED] ${reportText}`
    expect(isFailedReport(prefixed)).toBe(true)
    expect(isOperationalAlert(prefixed)).toBe(true)
  })

  test('server injects [BLOCKED] prefix for priority=blocked → dispatcher detects high priority', () => {
    const reportText = 'waiting on upstream API deployment'
    const prefixed = `[BLOCKED] ${reportText}`
    expect(isFailedReport(prefixed)).toBe(true)
  })

  test('server keyword fallback injects [FAILED] when text contains "failed" → dispatcher detects', () => {
    const reportText = 'compilation failed with 3 errors'
    const prefixed = `[FAILED] ${reportText}`
    expect(isFailedReport(prefixed)).toBe(true)
  })

  test('no prefix injected for normal priority → dispatcher does NOT flag', () => {
    const reportText = 'task completed successfully, all tests pass'
    expect(isFailedReport(reportText)).toBe(false)
    expect(isOperationalAlert(reportText)).toBe(false)
  })
})
