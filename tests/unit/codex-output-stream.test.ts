// @vitest-environment jsdom
import { Terminal } from '@xterm/headless'
import { describe, expect, test } from 'vitest'

import { createTerminalOutputRenderQueue } from '../../web/src/terminal/terminal-output-render-queue.js'

const ESC = '\x1b'
const start = `${ESC}[?2026h${ESC}[1;1Hhello`
const finish = `${ESC}[1;1H${ESC}[K${ESC}[0 q${ESC}[?25h${ESC}[?2026l${ESC}[?25l`

async function render(chunks: string[]) {
  const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true })
  let forwarded = ''
  let written: () => void = () => {}
  const queue = createTerminalOutputRenderQueue({
    canRender: () => true,
    write: (chunk, done) => {
      forwarded += chunk
      terminal.write(chunk, () => {
        done()
        written()
      })
    },
  })
  try {
    for (const chunk of chunks) {
      if (!chunk) continue
      await new Promise<void>((resolve) => {
        written = resolve
        queue.enqueue(chunk, new TextEncoder().encode(chunk).length, () => {})
        queue.flush()
      })
    }
    return {
      line: terminal.buffer.active.getLine(0)?.translateToString(true),
      x: terminal.buffer.active.cursorX,
      y: terminal.buffer.active.cursorY,
      forwarded,
    }
  } finally {
    queue.dispose()
    terminal.dispose()
  }
}

describe('Codex terminal output is a byte stream, not per-chunk drawing frames', () => {
  test('clears the old prompt after a split synchronized repaint', async () => {
    expect(await render([start, finish])).toEqual({
      line: '',
      x: 0,
      y: 0,
      forwarded: start + finish,
    })
  })

  test('preserves all control bytes at every stream split, including hide and sync end', async () => {
    const stream = start + finish
    for (let split = 0; split <= stream.length; split++) {
      expect(await render([stream.slice(0, split), stream.slice(split)])).toEqual({
        line: '',
        x: 0,
        y: 0,
        forwarded: stream,
      })
    }
  })
})
