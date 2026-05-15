import { describe, expect, test } from 'vitest'

import { parseReportArgs } from '../../src/cli/team.js'

describe('parseReportArgs', () => {
  test('accepts the legacy positional-first form', () => {
    const parsed = parseReportArgs(['done', '--dispatch', 'abc', '--artifact', 'src/foo.ts'])
    expect(parsed).toEqual({ result: 'done', dispatchId: 'abc', artifacts: ['src/foo.ts'] })
  })

  test('accepts flags before the positional result', () => {
    const parsed = parseReportArgs(['--dispatch', 'abc', 'done'])
    expect(parsed).toEqual({ result: 'done', dispatchId: 'abc', artifacts: [] })
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
    })
  })

  test('treats --success and --failed as backward-compatible no-ops', () => {
    const parsed = parseReportArgs(['done', '--success', '--failed'])
    expect(parsed).toEqual({ result: 'done', dispatchId: undefined, artifacts: [] })
  })

  describe('error messages embed the usage line', () => {
    test('--dispatch without a value', () => {
      try {
        parseReportArgs(['done', '--dispatch'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('--dispatch requires a value')
        expect(message).toContain('Usage: team report <result>')
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

    test('missing positional result', () => {
      try {
        parseReportArgs(['--dispatch', 'abc'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Missing <result>')
        expect(message).toContain('Usage: team report <result>')
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
        expect(message).toContain('Usage: team status <current status>')
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
        expect(message).toContain('Usage: team status <current status>')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })
  })
})
