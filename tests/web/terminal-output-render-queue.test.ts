// @vitest-environment jsdom

import headlessModule from '@xterm/headless'
import type { IParser } from '@xterm/xterm'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createTerminalOutputRenderQueue } from '../../web/src/terminal/terminal-output-render-queue.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('terminal output render queue', () => {
  test('a geometry barrier and byte ACK wait for the native parser', async () => {
    vi.useFakeTimers()
    const terminal = new headlessModule.Terminal({ cols: 6, rows: 3, allowProposedApi: true })
    let releaseParser!: (handled: boolean) => void
    let parserBlocked = false
    // Headless 6.0's declaration omits the async handler supported by the shared
    // runtime parser. Use its browser public type; keep the real headless parser.
    const parser = terminal.parser as IParser
    parser.registerCsiHandler({ final: 'z' }, () => {
      parserBlocked = true
      return new Promise<boolean>((resolve) => {
        releaseParser = resolve
      })
    })
    const acks: number[] = []
    const queue = createTerminalOutputRenderQueue({
      onOverflow: () => {},
      write: (chunk, callback) => terminal.write(chunk, callback),
      resize: (cols, rows, callback) =>
        terminal.write('', () => {
          terminal.resize(cols, rows)
          callback()
        }),
    })
    try {
      queue.enqueue('\x1b[z123456', 9, (bytes) => acks.push(bytes))
      queue.enqueueResize(3, 3)
      queue.enqueue('\r\nNEW', 5, (bytes) => acks.push(bytes))
      await vi.advanceTimersByTimeAsync(3100)
      expect(parserBlocked).toBe(true)
      expect(acks).toEqual([])
      expect(terminal.cols).toBe(6)
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('')
      releaseParser(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(terminal.cols).toBe(3)
      expect(acks).toEqual([9, 5])
      const buffer = terminal.buffer.active
      expect(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)).toBe('NEW')
    } finally {
      queue.dispose()
      terminal.dispose()
    }
  })

  test('does not resize or render later output before the previous write completes', () => {
    vi.useFakeTimers()
    const applied: string[] = []
    let finishWrite: (() => void) | undefined
    const queue = createTerminalOutputRenderQueue({
      onOverflow: () => {},
      write: (chunk, callback) => {
        applied.push(chunk)
        finishWrite = callback
      },
      resize: (cols, rows, callback) => {
        applied.push(`${cols}x${rows}`)
        callback()
      },
    })
    queue.enqueue('old grid', 8, () => {})
    queue.enqueueResize(40, 24)
    queue.enqueue('new grid', 8, () => {})
    expect(applied).toEqual(['old grid'])
    finishWrite?.()
    vi.advanceTimersByTime(100)
    expect(applied).toEqual(['old grid', '40x24', 'new grid'])
    queue.dispose()
  })

  test('parses parked output and acknowledges only after the write completes', () => {
    let complete!: () => void
    const writes: string[] = []
    const acks: number[] = []
    const queue = createTerminalOutputRenderQueue({
      onOverflow: () => {},
      write: (chunk, callback) => {
        writes.push(chunk)
        complete = callback
      },
    })
    queue.enqueue('hidden', 6, (bytes) => acks.push(bytes))
    expect(writes).toEqual(['hidden'])
    expect(acks).toEqual([])
    complete()
    expect(acks).toEqual([6])
    queue.dispose()
  })

  test('bounds blocked output and asks for a new snapshot without acknowledging it', () => {
    const acks: number[] = []
    let overflows = 0
    const queue = createTerminalOutputRenderQueue({
      onOverflow: () => {
        overflows++
      },
      write: () => {},
    })
    const acknowledge = (bytes: number) => acks.push(bytes)
    queue.enqueue('in flight', 9, acknowledge)
    for (let index = 0; index < 300; index++) queue.enqueue('x'.repeat(1024), 1024, acknowledge)
    expect(overflows).toBe(1)
    expect(acks).toEqual([])
    queue.dispose()
  })
  test('recovers a stalled parser through a fresh snapshot without false acknowledgement', () => {
    vi.useFakeTimers()
    let overflows = 0
    const acks: number[] = []
    const queue = createTerminalOutputRenderQueue({
      onOverflow: () => {
        overflows++
      },
      write: () => {},
    })
    queue.enqueue('blocked', 7, (bytes) => acks.push(bytes))
    vi.advanceTimersByTime(10_000)
    expect(overflows).toBe(1)
    expect(acks).toEqual([])
    queue.dispose()
  })
})
