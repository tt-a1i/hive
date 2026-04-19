import serializeAddonModule from '@xterm/addon-serialize'
import headlessTerminalModule from '@xterm/headless'

const { SerializeAddon } = serializeAddonModule as typeof import('@xterm/addon-serialize')
const { Terminal } = headlessTerminalModule as typeof import('@xterm/headless')

export const TERMINAL_SCROLLBACK = 10_000

export class TerminalStateMirror {
  private readonly serializeAddon = new SerializeAddon()
  private readonly terminal = new Terminal({
    allowProposedApi: true,
    cols: 80,
    rows: 24,
    scrollback: TERMINAL_SCROLLBACK,
  })
  private operationQueue: Promise<void> = Promise.resolve()

  constructor() {
    this.terminal.loadAddon(this.serializeAddon)
  }

  dispose() {
    this.terminal.dispose()
  }

  async getSnapshot() {
    await this.operationQueue
    return this.serializeAddon.serialize()
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
