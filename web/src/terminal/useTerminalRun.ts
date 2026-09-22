import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'

import { isRuntimeRunActive, RuntimeRunProbeError } from '../api.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { wrapBracketedPaste } from './bracketed-paste.js'
import { attachCompositionBridge, type CompositionBridge } from './composition.js'
import { resolveControlBytes, type TerminalKeyName } from './control-bytes.js'
import { resolveTerminalShortcut } from './shortcuts.js'
import type { TerminalClient } from './terminal-client.js'
import { createTerminalClient } from './terminal-client.js'
import {
  createTerminalOutputRenderQueue,
  type TerminalOutputRenderQueue,
} from './terminal-output-render-queue.js'
import {
  TERMINAL_VISIBLE_RESIZE_EVENT,
  type TerminalVisibleResizeEvent,
} from './terminal-resize-events.js'
import { attachTouchScroll } from './touch-scroll.js'
import { detectWebglSupport } from './webgl-support.js'
import {
  attachAlternateScreenWheelFallback,
  type TerminalWheelInputProfile,
} from './wheelFallback.js'

export type TerminalRenderer = 'webgl' | 'canvas'

type UseTerminalRunOptions = {
  autoFocusTarget?: HTMLElement | null
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

const isProtectedTextEntry = (element: Element | null): boolean => {
  if (!(element instanceof HTMLElement)) return false
  if (element.classList.contains('xterm-helper-textarea')) return false
  if (element.isContentEditable) return true
  if (element instanceof HTMLTextAreaElement) return true
  if (!(element instanceof HTMLInputElement)) return false
  return !element.disabled && !element.readOnly && !NON_TEXT_INPUT_TYPES.has(element.type)
}

const canAutoFocusTerminal = (container: HTMLElement, target: HTMLElement | null): boolean => {
  if (!target?.isConnected || !target.contains(container)) return false
  if (document.visibilityState === 'hidden') return false
  if (container.closest('[data-terminal-host-parked="true"]')) return false
  const activeElement = document.activeElement
  if (
    !activeElement ||
    activeElement === document.body ||
    activeElement === document.documentElement ||
    container.contains(activeElement)
  ) {
    return true
  }
  return !isProtectedTextEntry(activeElement)
}

const terminalLoadErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return `Terminal failed to load: ${error.message}`
  }
  return 'Terminal failed to load. Refresh this page and try again.'
}

const LEGACY_MOUSE_REPORT_PATTERN = new RegExp(
  `${String.fromCharCode(0x1b)}\\[M([\\s\\S])([\\s\\S])([\\s\\S])`,
  'g'
)
const terminalOutputEncoder = new TextEncoder()
const TERMINAL_CONNECT_RETRY_MS = 5000

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
  if (inputProfile !== 'grok' && inputProfile !== 'opencode') return { binary: true, chunk }
  const normalized = chunk.replace(LEGACY_MOUSE_REPORT_PATTERN, legacyMouseReportToSgr)
  return {
    binary: normalized === chunk,
    chunk: normalized,
  }
}

export const useTerminalRun = (
  runId: string,
  inputProfile: TerminalWheelInputProfile = 'default',
  onExit?: () => void,
  options: UseTerminalRunOptions = {}
) => {
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'connecting' | 'running' | 'stopped'>('connecting')
  const statusRef = useRef<'connecting' | 'running' | 'stopped'>('connecting')
  const connectedRunIdRef = useRef<string | null>(null)
  // Bumped when the terminal client surfaces a tunnel-drop close or fails to
  // receive its initial restore. It tears down the dead client and rebuilds it
  // with a fresh clientId, forcing attachControl to replay a fresh snapshot.
  const [reconnectEpoch, setReconnectEpoch] = useState(0)

  // Stable handles so the mobile keybar / composer / paste flow can drive input
  // from outside the effect. They mirror the effect-locals below and are nulled
  // on cleanup. Desktop input never touches these (it goes through onData).
  const clientRef = useRef<TerminalClient | null>(null)
  const terminalRef = useRef<XtermTerminal | null>(null)
  const autoFocusTargetRef = useRef<HTMLElement | null>(null)
  const autoFocusTimerRef = useRef<number | undefined>(undefined)
  // Promoted from a plain { current:false } object to a real ref: the same flag
  // gates xterm's onData (desktop) and the keybar/composer (mobile) so input
  // during IME composition is suppressed everywhere.
  const isComposingRef = useRef(false)
  const [renderer, setRenderer] = useState<TerminalRenderer>('canvas')
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const isScrolledUpRef = useRef(false)
  const onExitRef = useRef(onExit)

  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  const focusTerminal = useCallback(() => {
    const container = containerRef.current
    const terminal = terminalRef.current
    if (!container || !terminal) return
    if (!canAutoFocusTerminal(container, autoFocusTargetRef.current)) return
    terminal.focus()
  }, [])

  const scheduleTerminalFocus = useCallback(() => {
    if (!autoFocusTargetRef.current || autoFocusTimerRef.current !== undefined) return
    autoFocusTimerRef.current = window.setTimeout(() => {
      autoFocusTimerRef.current = undefined
      focusTerminal()
    }, 0)
  }, [focusTerminal])

  useEffect(() => {
    autoFocusTargetRef.current = options.autoFocusTarget ?? null
    scheduleTerminalFocus()
  }, [options.autoFocusTarget, scheduleTerminalFocus])

  useEffect(() => {
    const handleWindowFocus = () => scheduleTerminalFocus()
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') scheduleTerminalFocus()
    }
    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('focus', handleWindowFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (autoFocusTimerRef.current !== undefined) {
        window.clearTimeout(autoFocusTimerRef.current)
        autoFocusTimerRef.current = undefined
      }
    }
  }, [scheduleTerminalFocus])

  // Single funnel for renderer changes: state for React consumers + a DOM
  // attribute so a real phone (remote inspector) can confirm WebGL actually
  // engaged. Every path — initial open, webgl success, addon failure, context
  // loss — must go through this, or the attribute silently goes stale.
  const setTerminalRenderer = useCallback((next: TerminalRenderer) => {
    setRenderer(next)
    const node = containerRef.current
    if (node) node.dataset.renderer = next
  }, [])

  const sendInput = useCallback((chunk: string) => {
    if (isComposingRef.current) return
    clientRef.current?.sendInput(chunk)
  }, [])
  const sendKey = useCallback(
    (key: TerminalKeyName) => {
      const applicationCursorKeys = terminalRef.current?.modes?.applicationCursorKeysMode
      sendInput(
        resolveControlBytes(
          key,
          applicationCursorKeys === undefined ? {} : { applicationCursorKeys }
        )
      )
    },
    [sendInput]
  )
  const beginPaste = useCallback((text: string): string => {
    const wrapped = wrapBracketedPaste(text, terminalRef.current ?? undefined)
    // A confirmed paste rides through even while composing — it is an explicit
    // user gesture, not stray keystrokes, so it must not be swallowed.
    clientRef.current?.sendInput(wrapped)
    return wrapped
  }, [])
  const scrollToBottom = useCallback(() => {
    const forceViewportBottom = () => {
      terminalRef.current?.scrollToBottom()
      const viewport = containerRef.current?.querySelector<HTMLElement>('.xterm-viewport')
      if (!viewport) return
      viewport.scrollTop = viewport.scrollHeight
    }
    forceViewportBottom()
    window.requestAnimationFrame(() => {
      forceViewportBottom()
      window.requestAnimationFrame(forceViewportBottom)
    })
    window.setTimeout(forceViewportBottom, 80)
    isScrolledUpRef.current = false
    setIsScrolledUp(false)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectEpoch is a trigger-only dep — bumping it forces a full remount so the daemon replays a fresh snapshot; it is never read inside the effect.
  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false
    let onTerminalVisibleResize: ((event: Event) => void) | undefined
    let onWindowResize: (() => void) | undefined
    let binaryInputSubscription: { dispose: () => void } | undefined
    let inputSubscription: { dispose: () => void } | undefined
    let client: ReturnType<typeof createTerminalClient> | undefined
    let terminal: XtermTerminal | undefined
    let fitAddon: XtermFitAddon | undefined
    let resizeObserver: ResizeObserver | undefined
    let outputRenderQueue: TerminalOutputRenderQueue | undefined
    let resizeTimer: number | undefined
    let connectRetryTimer: number | undefined
    let wheelFallbackDispose: (() => void) | undefined
    let touchScrollDispose: (() => void) | undefined
    let compositionBridge: CompositionBridge | undefined
    let detachUserInputEvents: (() => void) | undefined
    let userInputEvent: Event | undefined
    let scrollSubscription: { dispose: () => void } | undefined
    let bufferChangeSubscription: { dispose: () => void } | undefined
    let scrollStateFrame: number | undefined
    let closeProbeGeneration = 0
    let lastResize:
      | {
          cols: number
          pixelHeight?: number
          pixelWidth?: number
          rows: number
        }
      | undefined

    setError(null)
    const initialStatus = connectedRunIdRef.current === runId ? 'running' : 'connecting'
    statusRef.current = initialStatus
    setStatus(initialStatus)
    isScrolledUpRef.current = false
    setIsScrolledUp(false)

    const setTerminalStatus = (nextStatus: 'connecting' | 'running' | 'stopped') => {
      if (nextStatus === 'running') connectedRunIdRef.current = runId
      if (statusRef.current === nextStatus) return
      statusRef.current = nextStatus
      setStatus(nextStatus)
    }
    const recoverAfterSocketClose = () => {
      const generation = ++closeProbeGeneration
      void isRuntimeRunActive(runId)
        .then((active) => {
          if (disposed || generation !== closeProbeGeneration) return
          if (!active) {
            setTerminalStatus('stopped')
            onExitRef.current?.()
            return
          }
          setReconnectEpoch((n) => n + 1)
        })
        .catch((error: unknown) => {
          if (disposed || generation !== closeProbeGeneration) return
          if (
            error instanceof RuntimeRunProbeError &&
            (error.status === 401 || error.status === 403)
          ) {
            setError(error.message)
            return
          }
          setReconnectEpoch((n) => n + 1)
        })
    }

    void Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-unicode11'),
      import('@xterm/addon-clipboard'),
    ])
      .then(([xtermModule, fitModule, unicode11Module, clipboardModule]) => {
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
          // 12 on phones: more columns (TUI boxes wrap less) and the user
          // verdict was that 14 reads oversized at arm's length.
          fontSize: isMobile ? 12 : 13,
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
        // Baseline before the async WebGL probe resolves — keeps data-renderer
        // truthful even when detectWebglSupport() is false and no fallback
        // callback ever fires.
        setTerminalRenderer('canvas')
        nextFitAddon.fit()
        terminal = nextTerminal
        terminalRef.current = nextTerminal
        fitAddon = nextFitAddon
        scheduleTerminalFocus()
        // Track whether the user has scrolled above the live bottom so callers can
        // show a jump-to-latest affordance. viewportY < baseY means the viewport
        // is not at the bottom of the buffer.
        const updateScrolledUp = () => {
          const buf = nextTerminal.buffer.active
          const nextScrolledUp = buf.viewportY < buf.baseY
          if (isScrolledUpRef.current === nextScrolledUp) return
          isScrolledUpRef.current = nextScrolledUp
          setIsScrolledUp(nextScrolledUp)
        }
        const scheduleScrolledUpUpdate = () => {
          if (scrollStateFrame !== undefined) return
          scrollStateFrame = window.requestAnimationFrame(() => {
            scrollStateFrame = undefined
            updateScrolledUp()
          })
        }
        scrollSubscription = nextTerminal.onScroll(scheduleScrolledUpUpdate)
        // xterm does not fire onScroll when switching between normal and alternate
        // buffers (e.g. vim/less open/close). Reset the flag on any buffer switch
        // so the jump-to-latest button doesn't stay stuck.
        bufferChangeSubscription = nextTerminal.buffer.onBufferChange(scheduleScrolledUpUpdate)
        const sendTerminalInput = (chunk: string) => {
          client?.sendInput(chunk)
        }
        wheelFallbackDispose = attachAlternateScreenWheelFallback({
          element: containerRef.current,
          profile: inputProfile,
          sendInput: sendTerminalInput,
          terminal: nextTerminal,
        })
        if (isMobile) {
          // Finger pans drive xterm directly: scrollback via scrollLines(),
          // alternate-screen TUIs via the same input fallback as wheel events.
          touchScrollDispose = attachTouchScroll({
            element: containerRef.current,
            profile: inputProfile,
            sendInput: sendTerminalInput,
            terminal: nextTerminal,
          })
        }

        // Take over IME composition so xterm's built-in CompositionHelper does
        // not emit spurious DEL (0x7f) bytes after each commit. Without this,
        // typing CJK in Claude Code's TUI prompt would commit the CJK chars
        // and then send a growing run of DELs that erased surrounding text. The
        // same flag gates onData below, so input during composition is suppressed.
        const helperTextarea =
          containerRef.current.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
        if (helperTextarea) {
          const mouseEvents = [
            'mousedown',
            'mouseup',
            'mousemove',
            'wheel',
            'touchstart',
            'touchmove',
            'touchend',
          ]
          const events = [
            'keydown',
            'keypress',
            'beforeinput',
            'input',
            'paste',
            'compositionend',
            ...mouseEvents,
          ]
          const markInput = (event: Event) => {
            const terminalPointer =
              mouseEvents.includes(event.type) &&
              event.target instanceof Node &&
              nextTerminal.element?.contains(event.target)
            if (event.target !== helperTextarea && !terminalPointer) return
            // Native events may run microtasks between capture and target
            // listeners. eventPhase tracks dispatch itself, not JS stack timing.
            userInputEvent = event
          }
          for (const event of events) document.addEventListener(event, markInput, true)
          detachUserInputEvents = () => {
            for (const event of events) document.removeEventListener(event, markInput, true)
          }
          compositionBridge = attachCompositionBridge(helperTextarea, {
            setComposing: (composing) => {
              isComposingRef.current = composing
            },
            commit: sendTerminalInput,
            input: (text) => nextTerminal.input(text, true),
          })
        }

        if (typeof nextTerminal.attachCustomKeyEventHandler === 'function') {
          nextTerminal.attachCustomKeyEventHandler((event) => {
            const action = resolveTerminalShortcut(event, {
              hasSelection: nextTerminal.hasSelection(),
            })
            switch (action.kind) {
              case 'send':
                event.preventDefault()
                sendTerminalInput(action.bytes)
                return false
              case 'clear':
                event.preventDefault()
                nextTerminal.clear()
                return false
              case 'copy': {
                // Off-mac Ctrl+C with a selection: copy instead of sending \x03
                // to the PTY. Returning false stops xterm from emitting the
                // interrupt byte; the clipboard write rides the keydown's user
                // gesture so it is allowed in the localhost secure context.
                event.preventDefault()
                const selection = nextTerminal.getSelection()
                if (selection) void navigator.clipboard?.writeText(selection).catch(() => {})
                // Drop the selection so the next Ctrl+C interrupts rather than
                // copying again — same as Windows Terminal, and it keeps a stale
                // selection from blocking SIGINT to a running agent.
                nextTerminal.clearSelection()
                return false
              }
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
        outputRenderQueue = createTerminalOutputRenderQueue({
          canRender: isContainerResizable,
          write: (chunk, callback) => nextTerminal.write(chunk, callback),
          resize: (cols, rows, callback) =>
            nextTerminal.write('', () => {
              if (disposed) return
              if (nextTerminal.cols !== cols || nextTerminal.rows !== rows)
                nextTerminal.resize(cols, rows)
              callback()
            }),
        })
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
          const beforePixels = getContainerPixels()
          if (!beforePixels.pixelHeight || !beforePixels.pixelWidth) return
          if (
            lastResize &&
            lastResize.pixelHeight === beforePixels.pixelHeight &&
            lastResize.pixelWidth === beforePixels.pixelWidth
          ) {
            return
          }
          const proposed = fitAddon?.proposeDimensions()
          const nextResize = {
            cols: proposed?.cols ?? terminal?.cols ?? 80,
            rows: proposed?.rows ?? terminal?.rows ?? 24,
            ...getContainerPixels(),
          }
          if (
            lastResize &&
            lastResize.cols === nextResize.cols &&
            lastResize.rows === nextResize.rows &&
            lastResize.pixelHeight === nextResize.pixelHeight &&
            lastResize.pixelWidth === nextResize.pixelWidth
          ) {
            return
          }
          lastResize = nextResize
          client?.resize(
            nextResize.cols,
            nextResize.rows,
            nextResize.pixelWidth,
            nextResize.pixelHeight
          )
        }
        const scheduleResize = () => {
          if (resizeTimer) window.clearTimeout(resizeTimer)
          resizeTimer = window.setTimeout(() => {
            resizeTimer = undefined
            resize()
          }, 50)
        }

        void import('@xterm/addon-web-links')
          .then((webLinksModule) => {
            if (disposed || terminal !== nextTerminal) return
            nextTerminal.loadAddon(new webLinksModule.WebLinksAddon())
          })
          .catch(() => {
            // Keep the core terminal usable when optional addons fail to load.
          })

        // Only load the WebGL addon when a context is actually available. Some
        // mobile browsers report no stable WebGL, where loading the addon
        // white-screens the terminal; there we keep xterm's default canvas
        // renderer. The try/catch + onContextLoss stay as a second net (a context
        // can still be lost after a successful detect).
        if (detectWebglSupport()) {
          void import('@xterm/addon-webgl')
            .then((webglModule) => {
              if (disposed || terminal !== nextTerminal) return
              try {
                const webglAddon = new webglModule.WebglAddon()
                webglAddon.onContextLoss(() => {
                  webglAddon.dispose()
                  setTerminalRenderer('canvas')
                })
                nextTerminal.loadAddon(webglAddon)
                setTerminalRenderer('webgl')
                scheduleResize()
              } catch {
                // Fall back to the default renderer when WebGL is unavailable.
                setTerminalRenderer('canvas')
              }
            })
            .catch(() => {
              // Fall back to the default renderer when the WebGL chunk is unavailable.
              setTerminalRenderer('canvas')
            })
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
            setTerminalStatus('stopped')
            onExitRef.current?.()
          },
          onOutput(chunk, acknowledge) {
            setTerminalStatus('running')
            const bytes = terminalOutputEncoder.encode(chunk).byteLength
            outputRenderQueue?.enqueue(chunk, bytes, acknowledge)
          },
          onResize(cols, rows) {
            outputRenderQueue?.enqueueResize(cols, rows)
          },
          onRestore(snapshot, onComplete, size) {
            setTerminalStatus('running')
            if (size && (nextTerminal.cols !== size.cols || nextTerminal.rows !== size.rows))
              nextTerminal.resize(size.cols, size.rows)
            if (snapshot.length === 0) {
              onComplete()
              return
            }
            nextTerminal.write(snapshot, onComplete)
          },
          onClose() {
            // A tunnel reconnect (or a dropped ws) closed the stream while this effect is still mounted.
            // First ask the runtime if this run still exists. A CLI can exit before the control
            // channel attaches; in that race the upgrade rejects and a blind remount loops forever
            // on "Connecting" for a run that is already gone.
            if (disposed) return
            recoverAfterSocketClose()
          },
          runId,
        })
        connectRetryTimer = window.setTimeout(() => {
          connectRetryTimer = undefined
          if (disposed || statusRef.current !== 'connecting') return
          setReconnectEpoch((n) => n + 1)
        }, TERMINAL_CONNECT_RETRY_MS)
        clientRef.current = client
        inputSubscription = nextTerminal.onData((chunk) => {
          const filtered = compositionBridge?.filterData(chunk) ?? chunk
          if (isComposingRef.current || !filtered) return
          client?.sendInput(
            filtered,
            userInputEvent !== undefined && userInputEvent.eventPhase !== Event.NONE
          )
        })
        if (typeof nextTerminal.onBinary === 'function') {
          binaryInputSubscription = nextTerminal.onBinary((chunk) => {
            const normalized = normalizeBinaryTerminalInput(chunk, inputProfile)
            if (normalized.binary) client?.sendBinaryInput(normalized.chunk)
            else client?.sendInput(normalized.chunk)
          })
        }
        resize()
        if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
          resizeObserver = new ResizeObserver(scheduleResize)
          resizeObserver.observe(containerRef.current)
        }
        onTerminalVisibleResize = (event) => {
          if ((event as TerminalVisibleResizeEvent).detail?.runId !== runId) return
          outputRenderQueue?.flush()
          scheduleResize()
        }
        onWindowResize = () => scheduleResize()
        window.addEventListener(TERMINAL_VISIBLE_RESIZE_EVENT, onTerminalVisibleResize)
        window.addEventListener('resize', onWindowResize)
      })
      .catch((error: unknown) => {
        if (disposed) return
        setError(terminalLoadErrorMessage(error))
        setTerminalStatus('stopped')
      })

    return () => {
      disposed = true
      if (onTerminalVisibleResize) {
        window.removeEventListener(TERMINAL_VISIBLE_RESIZE_EVENT, onTerminalVisibleResize)
      }
      if (onWindowResize) window.removeEventListener('resize', onWindowResize)
      resizeObserver?.disconnect()
      if (resizeTimer) window.clearTimeout(resizeTimer)
      if (connectRetryTimer) window.clearTimeout(connectRetryTimer)
      wheelFallbackDispose?.()
      touchScrollDispose?.()
      compositionBridge?.dispose()
      detachUserInputEvents?.()
      outputRenderQueue?.dispose()
      if (scrollStateFrame !== undefined) window.cancelAnimationFrame(scrollStateFrame)
      scrollSubscription?.dispose()
      bufferChangeSubscription?.dispose()
      binaryInputSubscription?.dispose()
      inputSubscription?.dispose()
      client?.dispose()
      terminal?.dispose()
      fitAddon?.dispose()
      clientRef.current = null
      terminalRef.current = null
    }
  }, [runId, inputProfile, reconnectEpoch])

  return {
    containerRef,
    error,
    status,
    sendInput,
    sendKey,
    beginPaste,
    renderer,
    isScrolledUp,
    scrollToBottom,
  }
}
