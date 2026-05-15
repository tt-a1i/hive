import serializeAddonModule from '@xterm/addon-serialize'
import headlessTerminalModule from '@xterm/headless'

const { SerializeAddon } = serializeAddonModule as typeof import('@xterm/addon-serialize')
const { Terminal } = headlessTerminalModule as typeof import('@xterm/headless')

export const TERMINAL_SCROLLBACK = 10_000

export interface TerminalMirrorSize {
  cols: number
  rows: number
}

const normalizeTerminalSize = ({ cols, rows }: TerminalMirrorSize): TerminalMirrorSize => ({
  cols: Math.max(1, Math.floor(cols)),
  rows: Math.max(1, Math.floor(rows)),
})

// Strips CSI escape sequences emitted by interactive CLIs (color, cursor moves,
// etc.) before exposing a single line of scrollback to JSON consumers. Built
// from a String so the regex source does not embed a literal control character
// (lint/suspicious/noControlCharactersInRegex would otherwise flag the file).
const ANSI_CSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[a-zA-Z]`, 'g')

export class TerminalStateMirror {
  private readonly serializeAddon = new SerializeAddon()
  private readonly terminal: InstanceType<typeof Terminal>
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(size: TerminalMirrorSize = { cols: 80, rows: 24 }) {
    const normalized = normalizeTerminalSize(size)
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: normalized.cols,
      rows: normalized.rows,
      scrollback: TERMINAL_SCROLLBACK,
    })
    this.terminal.loadAddon(this.serializeAddon)
  }

  dispose() {
    this.terminal.dispose()
  }

  async getSnapshot() {
    await this.operationQueue
    return this.serializeAddon.serialize()
  }

  /**
   * Returns the most recent non-empty scrollback line (trimmed, ANSI-stripped,
   * truncated to `maxLen`). Returns `null` when scrollback has no printable
   * content, so the wire protocol can express "no output yet" as a null.
   */
  lastPtyLine(maxLen = 60): string | null {
    const buffer = this.terminal.buffer.active
    for (let row = buffer.length - 1; row >= 0; row -= 1) {
      const raw = buffer.getLine(row)?.translateToString(true) ?? ''
      const cleaned = raw.replace(ANSI_CSI_PATTERN, '').trim()
      if (cleaned.length === 0) continue
      return cleaned.slice(0, maxLen)
    }
    return null
  }

  resize(cols: number, rows: number) {
    const normalized = normalizeTerminalSize({ cols, rows })
    this.operationQueue = this.operationQueue
      .catch(() => undefined)
      .then(() => {
        this.terminal.resize(normalized.cols, normalized.rows)
      })
  }

  write(chunk: string) {
    this.operationQueue = this.operationQueue
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            this.terminal.write(chunk, () => resolve())
          })
      )
  }
}
