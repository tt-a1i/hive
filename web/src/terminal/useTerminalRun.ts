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
    let resizeObserver: ResizeObserver | undefined
    let resizeTimer: number | undefined

    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(
      ([xtermModule, fitModule]) => {
        if (disposed || !containerRef.current) return

        const nextTerminal = new xtermModule.Terminal({
          convertEol: false,
          fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1,
          scrollback: 10_000,
          theme: {
            background: '#0f0f11',
            foreground: '#f7f8f8',
          },
        })
        const nextFitAddon = new fitModule.FitAddon()
        nextTerminal.loadAddon(nextFitAddon)
        nextTerminal.open(containerRef.current)
        nextFitAddon.fit()
        terminal = nextTerminal
        fitAddon = nextFitAddon

        const getContainerPixels = (): { pixelHeight?: number; pixelWidth?: number } => {
          if (!containerRef.current) return {}
          const pixelWidth = containerRef.current.clientWidth
          const pixelHeight = containerRef.current.clientHeight
          const pixels: { pixelHeight?: number; pixelWidth?: number } = {}
          if (pixelHeight > 0) pixels.pixelHeight = pixelHeight
          if (pixelWidth > 0) pixels.pixelWidth = pixelWidth
          return pixels
        }
        const resize = () => {
          if (!containerRef.current) return
          fitAddon?.fit()
          const { pixelHeight, pixelWidth } = getContainerPixels()
          client?.resize(terminal?.cols ?? 80, terminal?.rows ?? 24, pixelWidth, pixelHeight)
        }
        const scheduleResize = () => {
          if (resizeTimer) window.clearTimeout(resizeTimer)
          resizeTimer = window.setTimeout(() => {
            resizeTimer = undefined
            resize()
          }, 50)
        }

        client = createTerminalClient({
          initialSize: {
            cols: nextTerminal.cols,
            rows: nextTerminal.rows,
            ...getContainerPixels(),
          },
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
        if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
          resizeObserver = new ResizeObserver(scheduleResize)
          resizeObserver.observe(containerRef.current)
        }
        onWindowResize = () => resize()
        window.addEventListener('resize', onWindowResize)
      }
    )

    return () => {
      disposed = true
      if (onWindowResize) window.removeEventListener('resize', onWindowResize)
      resizeObserver?.disconnect()
      if (resizeTimer) window.clearTimeout(resizeTimer)
      inputSubscription?.dispose()
      client?.dispose()
      terminal?.dispose()
      fitAddon?.dispose()
    }
  }, [runId])

  return { containerRef, error, status }
}
