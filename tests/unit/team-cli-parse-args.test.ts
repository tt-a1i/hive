import { describe, expect, test } from 'vitest'

import { parseCancelArgs, parseReportArgs } from '../../src/cli/team.js'

describe('parseReportArgs', () => {
  test('accepts the legacy positional-first form', () => {
    const parsed = parseReportArgs(['done', '--dispatch', 'abc', '--artifact', 'src/foo.ts'])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: 'abc',
      artifacts: ['src/foo.ts'],
      priority: undefined,
      useStdin: false,
    })
  })

  test('accepts flags before the positional result', () => {
    const parsed = parseReportArgs(['--dispatch', 'abc', 'done'])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: 'abc',
      artifacts: [],
      priority: undefined,
      useStdin: false,
    })
  })

  test('accepts mixed flag and positional ordering', () => {
    const parsed = parseReportArgs([
      '--artifact',
      'src/a.ts',
      'done',
      '--dispatch',
      'abc',
      '--artifact',
      'src/b.ts',
    ])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: 'abc',
      artifacts: ['src/a.ts', 'src/b.ts'],
      priority: undefined,
      useStdin: false,
    })
  })

  test('treats --success and --failed as backward-compatible no-ops', () => {
    const parsed = parseReportArgs(['done', '--success', '--failed'])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: undefined,
      artifacts: [],
      priority: undefined,
      useStdin: false,
    })
  })

  test('--stdin marks the body as deferred to stdin and leaves result null', () => {
    const parsed = parseReportArgs(['--stdin', '--dispatch', 'abc'])
    expect(parsed).toEqual({
      result: null,
      dispatchId: 'abc',
      artifacts: [],
      priority: undefined,
      useStdin: true,
    })
  })

  test('--stdin works regardless of where it appears in argv', () => {
    expect(parseReportArgs(['--dispatch', 'abc', '--stdin']).useStdin).toBe(true)
    expect(parseReportArgs(['--artifact', 'a.ts', '--stdin']).useStdin).toBe(true)
  })

  test('--stdin combined with a positional is rejected', () => {
    try {
      parseReportArgs(['done', '--stdin'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('--stdin is mutually exclusive with a positional argument')
      expect(message).toContain('Usage:')
      return
    }
    throw new Error('expected parseReportArgs to throw')
  })

  test('--stdin works on the status command and reports against the status usage line', () => {
    expect(parseReportArgs(['--stdin'], 'status')).toEqual({
      result: null,
      dispatchId: undefined,
      artifacts: [],
      priority: undefined,
      useStdin: true,
    })
    try {
      parseReportArgs(['working', '--stdin'], 'status')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('--stdin is mutually exclusive with a positional argument')
      expect(message).toContain('Usage: team status')
      return
    }
    throw new Error('expected parseReportArgs to throw')
  })

  describe('error messages embed the usage line', () => {
    test('--dispatch without a value', () => {
      try {
        parseReportArgs(['done', '--dispatch'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('--dispatch requires a value')
        expect(message).toContain('Usage: team report')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('--artifact followed by another flag', () => {
      try {
        parseReportArgs(['done', '--artifact', '--dispatch', 'abc'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('--artifact requires a value')
        expect(message).toContain('Usage:')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('unknown flag', () => {
      try {
        parseReportArgs(['done', '--unknown'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Unknown argument: --unknown')
        expect(message).toContain('Usage:')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('missing positional result hints at --stdin', () => {
      try {
        parseReportArgs(['--dispatch', 'abc'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Missing <result>')
        expect(message).toContain('--stdin to read it from stdin')
        expect(message).toContain('Usage: team report')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('multiple positional results are rejected', () => {
      try {
        parseReportArgs(['first', 'second', '--dispatch', 'abc'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Expected exactly one result positional, got 2')
        expect(message).toContain('"first"')
        expect(message).toContain('"second"')
        expect(message).toContain('Usage:')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('--dispatch on a status command points back to team report', () => {
      try {
        parseReportArgs(['working', '--dispatch', 'abc'], 'status')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('team status does not accept --dispatch')
        expect(message).toContain('Usage: team status')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('status command missing positional uses status usage line', () => {
      try {
        parseReportArgs([], 'status')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Missing <current status>')
        expect(message).toContain('Usage: team status')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })
  })

  describe('--priority flag', () => {
    test('parses --priority failed', () => {
      const parsed = parseReportArgs(['done', '--priority', 'failed', '--dispatch', 'abc'])
      expect(parsed.priority).toBe('failed')
      expect(parsed.result).toBe('done')
    })

    test('parses --priority blocked', () => {
      const parsed = parseReportArgs(['done', '--priority', 'blocked'])
      expect(parsed.priority).toBe('blocked')
    })

    test('parses --priority normal', () => {
      const parsed = parseReportArgs(['done', '--priority', 'normal'])
      expect(parsed.priority).toBe('normal')
    })

    test('rejects invalid priority value', () => {
      try {
        parseReportArgs(['done', '--priority', 'urgent'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('--priority must be one of: failed, blocked, normal')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('rejects --priority on status command', () => {
      try {
        parseReportArgs(['working', '--priority', 'failed'], 'status')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('team status does not accept --priority')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })
  })
})

describe('parseCancelArgs', () => {
  test('requires a dispatch id and joins multi-word reasons', () => {
    expect(parseCancelArgs(['--dispatch', 'dispatch-1', 'Direction', 'changed'])).toEqual({
      dispatchId: 'dispatch-1',
      reason: 'Direction changed',
    })
  })

  test('rejects missing dispatch id with cancel usage', () => {
    try {
      parseCancelArgs(['Direction changed'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('Missing --dispatch <dispatch-id>')
      expect(message).toContain('Usage: team cancel')
      return
    }
    throw new Error('expected parseCancelArgs to throw')
  })
})
