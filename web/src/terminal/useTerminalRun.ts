import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { resolveTerminalShortcut } from './shortcuts.js'
import { createTerminalClient } from './terminal-client.js'
import {
  attachAlternateScreenWheelFallback,
  type TerminalWheelInputProfile,
} from './wheelFallback.js'

const LEGACY_MOUSE_REPORT_PATTERN = new RegExp(
  `${String.fromCharCode(0x1b)}\\[M([\\s\\S])([\\s\\S])([\\s\\S])`,
  'g'
)

const legacyMouseReportToSgr = (
  report: string,
  codeChar: string,
  colChar: string,
  rowChar: string
) => {
  const code = codeChar.charCodeAt(0) - 32
  const col = colChar.charCodeAt(0) - 32
  const row = rowChar.charCodeAt(0) - 32
  if (code < 0 || col < 1 || row < 1) return report
  const isRelease = (code & 3) === 3 && (code & 32) === 0 && (code & 64) === 0
  const final = isRelease ? 'm' : 'M'
  return `\x1b[<${code};${col};${row}${final}`
}

const normalizeBinaryTerminalInput = (
  chunk: string,
  inputProfile: TerminalWheelInputProfile
): { binary: boolean; chunk: string } => {
  if (inputProfile !== 'opencode') return { binary: true, chunk }
  const normalized = chunk.replace(LEGACY_MOUSE_REPORT_PATTERN, legacyMouseReportToSgr)
  return {
    binary: normalized === chunk,
    chunk: normalized,
  }
}

export const useTerminalRun = (
  runId: string,
  inputProfile: TerminalWheelInputProfile = 'default'
) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'connecting' | 'running' | 'stopped'>('connecting')

  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false
    let onWindowResize: (() => void) | undefined
    let binaryInputSubscription: { dispose: () => void } | undefined
    let inputSubscription: { dispose: () => void } | undefined
    let client: ReturnType<typeof createTerminalClient> | undefined
    let terminal: XtermTerminal | undefined
    let fitAddon: XtermFitAddon | undefined
    let resizeObserver: ResizeObserver | undefined
    let resizeTimer: number | undefined
    let wheelFallbackDispose: (() => void) | undefined
    let themeObserver: MutationObserver | undefined
    let helperTextarea: HTMLTextAreaElement | null = null
    let onCompositionStart: ((event: Event) => void) | undefined
    let onCompositionEnd: ((event: Event) => void) | undefined
    const isComposingRef = { current: false }

    void Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-unicode11'),
      import('@xterm/addon-clipboard'),
    ]).then(([xtermModule, fitModule, unicode11Module, clipboardModule]) => {
      if (disposed || !containerRef.current) return

      // Read xterm background from CSS so it stays in sync if the palette
      // shifts. Falls back to bg-crust's literal value if computed style is
      // unavailable (jsdom). Without this, xterm's canvas sat at #0f0f11 and
      // the wrapping container at #1b1b1b, so unfilled rows showed a seam.
      const rootStyles =
        typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null
      const bgCrust = rootStyles?.getPropertyValue('--bg-crust').trim() || '#0e0e0e'
      const textPrimary = rootStyles?.getPropertyValue('--text-primary').trim() || '#ebebeb'
      const nextTerminal = new xtermModule.Terminal({
        allowProposedApi: true,
        convertEol: false,
        fontFamily: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        letterSpacing: 0,
        lineHeight: 1,
        scrollback: 10_000,
        theme: {
          background: bgCrust,
          foreground: textPrimary,
        },
      })
      const nextFitAddon = new fitModule.FitAddon()
      nextTerminal.loadAddon(nextFitAddon)
      nextTerminal.loadAddon(new unicode11Module.Unicode11Addon())
      nextTerminal.unicode.activeVersion = '11'
      nextTerminal.loadAddon(new clipboardModule.ClipboardAddon())
      nextTerminal.open(containerRef.current)
      nextFitAddon.fit()
      terminal = nextTerminal
      fitAddon = nextFitAddon
      wheelFallbackDispose = attachAlternateScreenWheelFallback({
        element: containerRef.current,
        profile: inputProfile,
        sendInput: (chunk) => client?.sendInput(chunk),
        terminal: nextTerminal,
      })

      void import('@xterm/addon-web-links')
        .then((webLinksModule) => {
          if (disposed || terminal !== nextTerminal) return
          nextTerminal.loadAddon(new webLinksModule.WebLinksAddon())
        })
        .catch(() => {
          // Keep the core terminal usable when optional addons fail to load.
        })

      void import('@xterm/addon-webgl')
        .then((webglModule) => {
          if (disposed || terminal !== nextTerminal) return
          try {
            const webglAddon = new webglModule.WebglAddon()
            webglAddon.onContextLoss(() => webglAddon.dispose())
            nextTerminal.loadAddon(webglAddon)
          } catch {
            // Fall back to the default renderer when WebGL is unavailable.
          }
        })
        .catch(() => {
          // Fall back to the default renderer when the WebGL chunk is unavailable.
        })

      // Take over IME composition so xterm's built-in CompositionHelper does
      // not emit spurious DEL (0x7f) bytes after each commit. Without this,
      // typing CJK in Claude Code's TUI prompt would commit the CJK chars
      // and then send a growing run of DELs that erased surrounding text.
      helperTextarea =
        containerRef.current.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      if (helperTextarea) {
        const localTextarea = helperTextarea
        onCompositionStart = () => {
          isComposingRef.current = true
        }
        onCompositionEnd = (event: Event) => {
          const composed = (event as CompositionEvent).data
          if (composed) client?.sendInput(composed)
          // Clear the textarea so xterm's built-in helper has nothing to
          // commit on its deferred setTimeout(0) read, and so its tracked
          // value never accumulates across compositions.
          localTextarea.value = ''
          // Release the flag in a later macrotask so the built-in helper's
          // own setTimeout(0) work fires while we are still filtering.
          setTimeout(() => {
            isComposingRef.current = false
          }, 0)
        }
        helperTextarea.addEventListener('compositionstart', onCompositionStart, { capture: true })
        helperTextarea.addEventListener('compositionend', onCompositionEnd, { capture: true })
      }

      if (typeof nextTerminal.attachCustomKeyEventHandler === 'function') {
        nextTerminal.attachCustomKeyEventHandler((event) => {
          const action = resolveTerminalShortcut(event)
          switch (action.kind) {
            case 'send':
              event.preventDefault()
              client?.sendInput(action.bytes)
              return false
            case 'clear':
              event.preventDefault()
              nextTerminal.clear()
              return false
            case 'block':
              // Intentionally NOT calling preventDefault here. Shift+Enter
              // depends on keydown → keypress chaining; if we preventDefault
              // on keydown the browser cancels the corresponding keypress and
              // the 'send' branch never gets to emit \x1b[13;2u.
              return false
            case 'passthrough':
              return true
          }
        })
      }

      const isContainerResizable = (): boolean => {
        const container = containerRef.current
        if (!container?.isConnected) return false
        return !container.closest('[data-terminal-host-parked="true"]')
      }
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
        if (!containerRef.current || !isContainerResizable()) return
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
      inputSubscription = nextTerminal.onData((chunk) => {
        if (isComposingRef.current) return
        client?.sendInput(chunk)
      })
      if (typeof nextTerminal.onBinary === 'function') {
        binaryInputSubscription = nextTerminal.onBinary((chunk) => {
          const normalized = normalizeBinaryTerminalInput(chunk, inputProfile)
          if (normalized.binary) client?.sendBinaryInput(normalized.chunk)
          else client?.sendInput(normalized.chunk)
        })
      }
      setStatus('running')
      resize()
      if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
        resizeObserver = new ResizeObserver(scheduleResize)
        resizeObserver.observe(containerRef.current)
      }
      onWindowResize = () => resize()
      window.addEventListener('resize', onWindowResize)

      themeObserver = new MutationObserver(() => {
        if (!terminal) return
        const rs = getComputedStyle(document.documentElement)
        const bg = rs.getPropertyValue('--bg-crust').trim() || '#0e0e0e'
        const fg = rs.getPropertyValue('--text-primary').trim() || '#ebebeb'
        terminal.options.theme = { background: bg, foreground: fg }
      })
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    })

    return () => {
      disposed = true
      if (onWindowResize) window.removeEventListener('resize', onWindowResize)
      resizeObserver?.disconnect()
      themeObserver?.disconnect()
      if (resizeTimer) window.clearTimeout(resizeTimer)
      wheelFallbackDispose?.()
      if (helperTextarea && onCompositionStart) {
        helperTextarea.removeEventListener('compositionstart', onCompositionStart, {
          capture: true,
        } as EventListenerOptions)
      }
      if (helperTextarea && onCompositionEnd) {
        helperTextarea.removeEventListener('compositionend', onCompositionEnd, {
          capture: true,
        } as EventListenerOptions)
      }
      binaryInputSubscription?.dispose()
      inputSubscription?.dispose()
      client?.dispose()
      terminal?.dispose()
      fitAddon?.dispose()
    }
  }, [runId, inputProfile])

  return { containerRef, error, status }
}
