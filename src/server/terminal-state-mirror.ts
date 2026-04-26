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
