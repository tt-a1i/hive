import { describe, expect, test } from 'vitest'

import {
  parseTerminalControlMessage,
  parseTerminalRenderInput,
} from '../../src/server/terminal-protocol.js'

describe('terminal control protocol', () => {
  test.each([
    [32768, 1],
    [1, 32768],
    [1001, 1000],
    [2147483647, 2147483647],
  ])('rejects oversized grid %i by %i on control and input paths', (cols, rows) => {
    expect(() =>
      parseTerminalControlMessage(JSON.stringify({ type: 'resize', cols, rows }))
    ).toThrow(RangeError)
    expect(() =>
      parseTerminalRenderInput(JSON.stringify({ type: 'input', data: 'a', cols, rows }))
    ).toThrow(RangeError)
  })
  test('accepts positive resize dimensions', () => {
    expect(
      parseTerminalControlMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    ).toEqual({ type: 'resize', cols: 120, rows: 40 })
  })

  test('rejects zero or negative resize dimensions before they reach node-pty', () => {
    expect(() =>
      parseTerminalControlMessage(JSON.stringify({ type: 'resize', cols: 0, rows: 40 }))
    ).toThrow('Invalid terminal control message')
    expect(() =>
      parseTerminalControlMessage(JSON.stringify({ type: 'resize', cols: 120, rows: -1 }))
    ).toThrow('Invalid terminal control message')
  })

  test('drops negative pixel dimensions while keeping the character resize', () => {
    expect(
      parseTerminalControlMessage(
        JSON.stringify({ type: 'resize', cols: 120, rows: 40, pixelWidth: -1, pixelHeight: 900 })
      )
    ).toEqual({ type: 'resize', cols: 120, rows: 40, pixelHeight: 900 })
  })
})
