import unicode11Module from '@xterm/addon-unicode11'
import headlessModule from '@xterm/headless'
import { expect, test } from 'vitest'
import { TerminalStateMirror } from '../../src/server/terminal-state-mirror.js'

const { Terminal } = headlessModule
const { Unicode11Addon } = unicode11Module

test('snapshot restoration preserves emoji cell widths and cursor edits', async () => {
  const mirror = new TerminalStateMirror({ cols: 5, rows: 5 })
  const restored = new Terminal({ cols: 5, rows: 5, allowProposedApi: true })
  restored.loadAddon(new Unicode11Addon())
  restored.unicode.activeVersion = '11'
  try {
    mirror.write('A😀BCDEF\x1b[1;4HZ')
    const snapshot = await mirror.getSnapshot()
    await new Promise<void>((resolve) => restored.write(snapshot, resolve))
    const buffer = restored.buffer.active
    expect(buffer.getLine(0)?.translateToString(true)).toBe('A😀ZC')
    expect(buffer.getLine(1)?.translateToString(true)).toBe('DEF')
    expect([buffer.cursorX, buffer.cursorY]).toEqual([4, 0])
  } finally {
    restored.dispose()
    mirror.dispose()
  }
})
