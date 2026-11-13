import { describe, expect, test } from 'vitest'

import {
  decodeStdinBuffer,
  parseCancelArgs,
  parseRecallArgs,
  parseReportArgs,
  parseReviewArgs,
  TeamUsageError,
} from '../../src/cli/team.js'

describe('parseReportArgs', () => {
  test('accepts the legacy positional-first form', () => {
    const parsed = parseReportArgs(['done', '--dispatch', 'abc', '--artifact', 'src/foo.ts'])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: 'abc',
      artifacts: ['src/foo.ts'],
      useStdin: false,
    })
  })

  test('accepts flags before the positional result', () => {
    const parsed = parseReportArgs(['--dispatch', 'abc', 'done'])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: 'abc',
      artifacts: [],
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
      useStdin: false,
    })
  })

  test('treats --success and --failed as backward-compatible no-ops', () => {
    const parsed = parseReportArgs(['done', '--success', '--failed'])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: undefined,
      artifacts: [],
      useStdin: false,
    })
  })

  test('--stdin marks the body as deferred to stdin and leaves result null', () => {
    const parsed = parseReportArgs(['--stdin', '--dispatch', 'abc'])
    expect(parsed).toEqual({
      result: null,
      dispatchId: 'abc',
      artifacts: [],
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
})

describe('parseReviewArgs', () => {
  test('accepts flags in any order with a positional focus', () => {
    expect(
      parseReviewArgs([
        '--role',
        'tester',
        '--cli',
        'codex',
        'uncommitted auth retry',
        '--name',
        'inspector',
        '--model',
        'gpt-5',
      ])
    ).toEqual({
      cli: 'codex',
      focus: 'uncommitted auth retry',
      model: 'gpt-5',
      name: 'inspector',
      role: 'tester',
      useStdin: false,
    })
  })

  test('--stdin defers the focus and rejects a positional', () => {
    expect(parseReviewArgs(['--stdin', '--cli', 'gemini'])).toEqual({
      cli: 'gemini',
      focus: null,
      useStdin: true,
    })
    try {
      parseReviewArgs(['look at diff', '--stdin'])
      throw new Error('expected TeamUsageError')
    } catch (error) {
      expect(error).toBeInstanceOf(TeamUsageError)
      expect((error as TeamUsageError).code).toBe('REVIEW_STDIN_EXCLUSIVE')
    }
  })

  test('rejects a missing focus with review usage', () => {
    try {
      parseReviewArgs(['--cli', 'claude'])
      throw new Error('expected TeamUsageError')
    } catch (error) {
      expect(error).toBeInstanceOf(TeamUsageError)
      expect((error as TeamUsageError).code).toBe('REVIEW_MISSING_FOCUS')
    }
  })

  test('rejects an invalid role with review usage', () => {
    try {
      parseReviewArgs(['--role', 'coder', 'focus'])
      throw new Error('expected TeamUsageError')
    } catch (error) {
      expect(error).toBeInstanceOf(TeamUsageError)
      expect((error as TeamUsageError).code).toBe('REVIEW_INVALID_ROLE')
    }
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

describe('parseRecallArgs', () => {
  test('joins query words and accepts flags in any order', () => {
    expect(parseRecallArgs(['--limit', '5', '远程', '访问链', '--window', '1'])).toEqual({
      limit: 5,
      query: '远程 访问链',
      window: 1,
    })
  })

  test('rejects invalid numeric flags with recall usage', () => {
    try {
      parseRecallArgs(['远程访问链', '--limit', '-1'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('--limit must be a non-negative integer')
      expect(message).toContain('Usage: team recall')
      return
    }
    throw new Error('expected parseRecallArgs to throw')
  })
})

describe('decodeStdinBuffer', () => {
  test('strips UTF-8 BOM produced by some Windows editors', () => {
    expect(decodeStdinBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x64, 0x6f, 0x6e, 0x65]))).toBe('done')
  })

  test('decodes UTF-16LE stdin with BOM from Windows tooling', () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('完成', 'utf16le')])
    expect(decodeStdinBuffer(body)).toBe('完成')
  })

  test('decodes UTF-16BE stdin with BOM', () => {
    const body = Buffer.from([0xfe, 0xff, 0x00, 0x6f, 0x00, 0x6b])
    expect(decodeStdinBuffer(body)).toBe('ok')
  })
})

describe('option delimiters', () => {
  test('accepts equals values, repeated artifacts, and literal report text', () => {
    expect(
      parseReportArgs(['--dispatch=d1', '--artifact=a', '--artifact=b', '--', '--help'])
    ).toMatchObject({
      dispatchId: 'd1',
      artifacts: ['a', 'b'],
      result: '--help',
    })
    expect(parseRecallArgs(['--limit=3', '--', '--port'])).toEqual({ query: '--port', limit: 3 })
  })

  test('preserves attached option values including dashes and newlines', () => {
    expect(parseReportArgs(['--artifact=-file', '--artifact=--', 'done']).artifacts).toEqual([
      '-file',
      '--',
    ])
    expect(parseCancelArgs(['--dispatch=--value', 'reason']).dispatchId).toBe('--value')
    expect(parseReviewArgs(['--name=line1\nline2', 'review']).name).toBe('line1\nline2')
  })

  test('rejects unknown short flags and values on boolean flags', () => {
    expect(() => parseReportArgs(['-x'])).toThrow(/Unknown argument/)
    expect(() => parseReportArgs(['--stdin=yes'])).toThrow(/does not take a value/)
    expect(() => parseReviewArgs(['-x'])).toThrow(/Unknown argument/)
  })
})
