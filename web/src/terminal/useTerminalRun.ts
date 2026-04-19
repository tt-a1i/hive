import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { createTerminalClient } from './terminal-client.js'

export const useTerminalRun = (runId: string) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'connecting' | 'running' | 'stopped'>('connecting')

  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false
    let onWindowResize: (() => void) | undefined
    let inputSubscription: { dispose: () => void } | undefined
    let client: ReturnType<typeof createTerminalClient> | undefined
    let terminal: XtermTerminal | undefined
    let fitAddon: XtermFitAddon | undefined

    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(
      ([xtermModule, fitModule]) => {
        if (disposed || !containerRef.current) return

        const nextTerminal = new xtermModule.Terminal({ convertEol: true })
        const nextFitAddon = new fitModule.FitAddon()
        nextTerminal.loadAddon(nextFitAddon)
        nextTerminal.open(containerRef.current)
        terminal = nextTerminal
        fitAddon = nextFitAddon

        const resize = () => {
          fitAddon?.fit()
          client?.resize(
            terminal?.cols ?? 80,
            terminal?.rows ?? 24,
            containerRef.current?.clientWidth,
            containerRef.current?.clientHeight
          )
        }

        client = createTerminalClient({
          onError(message) {
            setError(message)
          },
          onExit() {
            setStatus('stopped')
          },
          onOutput(chunk, acknowledge) {
            nextTerminal.write(chunk, () => acknowledge(new TextEncoder().encode(chunk).byteLength))
          },
          onRestore(snapshot) {
            nextTerminal.write(snapshot)
          },
          runId,
        })
        inputSubscription = nextTerminal.onData((chunk) => client?.sendInput(chunk))
        setStatus('running')
        resize()
        onWindowResize = () => resize()
        window.addEventListener('resize', onWindowResize)
      }
    )

    return () => {
      disposed = true
      if (onWindowResize) window.removeEventListener('resize', onWindowResize)
      inputSubscription?.dispose()
      client?.dispose()
      terminal?.dispose()
      fitAddon?.dispose()
    }
  }, [runId])

  return { containerRef, error, status }
}
