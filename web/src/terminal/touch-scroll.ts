import {
  createAlternateScreenWheelInputResolver,
  type TerminalWheelInputProfile,
} from './wheelFallback.js'

type TouchScrollableTerminal = Parameters<typeof createAlternateScreenWheelInputResolver>[0] & {
  scrollLines?: (amount: number) => void
  rows?: number
}

// Fallback only — the real cell height is measured per gesture from
// viewport.clientHeight / rows so finger travel maps 1:1 to lines.
const DEFAULT_CELL_HEIGHT_PX = 16
const MOMENTUM_MIN_VELOCITY_PX_PER_MS = 0.08
// ~iOS-like glide. Decay is per 16.67ms frame, time-normalized in runMomentum.
const MOMENTUM_DECAY_PER_FRAME = 0.96
const MOMENTUM_STOP_VELOCITY_PX_PER_MS = 0.025
const MOMENTUM_MAX_VELOCITY_PX_PER_MS = 5
// Flick velocity comes from the touch samples of the last ~100ms before lift.
const FLICK_SAMPLE_WINDOW_MS = 100
const FLICK_SAMPLE_CAP = 8
// Alt-screen emits real key sequences — cap a single flush so one long frame
// can't flood the TUI with input. Pages move a screenful each, cap tighter.
const MAX_ARROWS_PER_FLUSH = 6
const MAX_PAGES_PER_FLUSH = 4
// Alt-screen flick "coast": a real flick converts into a bounded budget of
// extra lines (~250ms of travel, hard cap) drained a couple per frame. Keyed
// scrolling can't glide like a scrollbar — but a dead stop on finger-lift
// made TUI history a swipe-swipe-swipe grind. default profile only: a PgUp
// flood is a screenful per key, far too coarse to coast.
const ALT_GLIDE_MIN_VELOCITY_PX_PER_MS = 0.5
const ALT_GLIDE_TRAVEL_MS = 250
const ALT_GLIDE_MAX_LINES = 24
const ALT_GLIDE_LINES_PER_FRAME = 2
const VIEWPORT_SELECTOR = '.xterm-viewport'
const SCREEN_SELECTOR = '.xterm-screen'
type ViewportScrollResult = 'missing' | 'moved' | 'stuck'

// xterm has no native touch scrolling: its .xterm-screen layer sits over the
// scrollable viewport, so finger pans never reach it. Drive xterm directly
// instead of dispatching a synthetic wheel event at a parent node; real xterm
// installs wheel handlers on its internal viewport/screen, and DOM events do
// not travel from parent to child.
//
// Two buffers, two paths:
//   normal    → pixel-true viewport.scrollTop (+ rAF-coalesced) + momentum
//   alternate → whole lines converted to arrow/PgUp sequences via the wheel
//               resolver. Called in LINE mode on purpose: the resolver's
//               trackpad damping only applies to PIXEL deltas and would eat
//               ~70% of every finger pan. No momentum here — gliding key
//               floods would swamp the TUI.
export function attachTouchScroll({
  element,
  profile = 'default',
  sendInput,
  terminal,
}: {
  element: HTMLElement
  profile?: TerminalWheelInputProfile
  sendInput: (chunk: string) => void
  terminal: TouchScrollableTerminal
}): () => void {
  let lastY: number | null = null
  // Per-buffer sub-line accumulators — never shared: a buffer switch mid-app
  // (TUI opening/closing) must not leak a fraction into the other path.
  let normalPartialLines = 0
  let alternatePartialLines = 0
  let lastBufferType: string | undefined
  let velocityPxPerMs = 0
  let momentumFrame: number | null = null
  let lastMomentumAt = 0
  let normalBufferPan = false
  let viewport: HTMLElement | null = null
  let screen: HTMLElement | null = null
  let cellHeightPx = DEFAULT_CELL_HEIGHT_PX
  // Sub-line remainder carried as a translateY on .xterm-screen: xterm renders
  // whole lines only, so scrollTop alone steps ~a cell at a time. The
  // transform fills in the fraction and the content tracks the finger
  // pixel-for-pixel; it settles to the nearest line when the gesture ends.
  let subLinePx = 0
  let pendingDy = 0
  let flushFrame: number | null = null
  let samples: Array<{ t: number; y: number }> = []
  const resolveAlternateWheelInput = createAlternateScreenWheelInputResolver(terminal, profile)

  const stopMomentum = () => {
    if (momentumFrame === null) return
    window.cancelAnimationFrame(momentumFrame)
    momentumFrame = null
  }

  const cancelFlush = () => {
    if (flushFrame === null) return
    window.cancelAnimationFrame(flushFrame)
    flushFrame = null
  }

  // Cache the viewport per attachment; touchmove fires at up to 120Hz and a
  // querySelector per event is pure waste. Re-resolve only when stale.
  const resolveViewport = (): HTMLElement | null => {
    if (viewport?.isConnected) return viewport
    viewport = element.querySelector<HTMLElement>(VIEWPORT_SELECTOR)
    return viewport
  }

  const resolveScreen = (): HTMLElement | null => {
    if (screen?.isConnected) return screen
    screen = element.querySelector<HTMLElement>(SCREEN_SELECTOR)
    return screen
  }

  // Finger travel ↔ line mapping uses the REAL cell height (re-measured at
  // every touchstart — font/refit safe). The 16px constant under-scrolled by
  // ~15% at the mobile 12px font.
  const measureCellHeight = () => {
    const node = resolveViewport()
    const rows = terminal.rows
    if (!node || !rows || rows <= 0) return
    const measured = node.clientHeight / rows
    if (measured >= 6 && measured <= 64) cellHeightPx = measured
  }

  const applySubLine = () => {
    const node = resolveScreen()
    if (!node) return
    node.style.transform = subLinePx !== 0 ? `translateY(${-subLinePx}px)` : ''
  }

  const clearSubLine = () => {
    if (subLinePx === 0) return
    subLinePx = 0
    applySubLine()
  }

  // Gesture over: round the fractional offset to the nearest whole line so
  // the buffer position matches what the eye sees, then drop the transform.
  const settleSubLine = () => {
    if (Math.abs(subLinePx) >= cellHeightPx / 2) {
      const node = resolveViewport()
      if (node) {
        const maxScrollTop = node.scrollHeight - node.clientHeight
        const step = subLinePx > 0 ? cellHeightPx : -cellHeightPx
        node.scrollTop = Math.min(maxScrollTop, Math.max(0, node.scrollTop + step))
      }
    }
    clearSubLine()
  }

  // Whole lines land in scrollTop (xterm's grid), the remainder rides the
  // screen transform. xterm itself keeps scrollTop line-aligned, so feeding
  // it exact multiples keeps its row math deterministic.
  const scrollViewportByPixels = (dy: number): ViewportScrollResult => {
    const node = resolveViewport()
    if (!node) return 'missing'
    const maxScrollTop = node.scrollHeight - node.clientHeight
    if (maxScrollTop <= 0) {
      clearSubLine()
      return 'stuck'
    }

    const desired = subLinePx + dy
    const wholeLines = Math.trunc(desired / cellHeightPx)
    let remainder = desired - wholeLines * cellHeightPx
    const current = node.scrollTop
    const target = Math.min(maxScrollTop, Math.max(0, current + wholeLines * cellHeightPx))
    const movedWhole = target !== current
    if (movedWhole) node.scrollTop = target
    // Pin the fraction at the edges — floating past the first/last line would
    // show a phantom gap that snaps back.
    if ((target <= 0 && desired < 0) || (target >= maxScrollTop && desired > 0)) {
      remainder = 0
    }
    const movedFraction = remainder !== subLinePx
    subLinePx = remainder
    if (movedFraction) applySubLine()
    return movedWhole || movedFraction ? 'moved' : 'stuck'
  }

  const scrollLineFallback = (dy: number): boolean => {
    normalPartialLines += dy / cellHeightPx
    const lines = Math.trunc(normalPartialLines)
    normalPartialLines %= 1
    if (lines === 0) return true
    terminal.scrollLines?.(lines)
    return true
  }

  // Emit up to `count` one-line key sequences in the given direction as ONE
  // sendInput chunk: per-key sends mean N relay frames and N TUI redraws per
  // scrolled frame over the phone tunnel; joined, the TUI reads the burst in
  // one pass and redraws once. The resolver still owns the guards
  // (mouse-tracking modes, profile) per step. Returns how many were emitted.
  const emitAlternateLines = (step: 1 | -1, count: number): number => {
    const parts: string[] = []
    for (let i = 0; i < count; i++) {
      const { handled, input } = resolveAlternateWheelInput({
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: step,
        shiftKey: false,
      })
      // Buffer flipped or mouse tracking grabbed the wheel mid-loop — stop.
      if (!handled) break
      if (input) parts.push(input)
    }
    if (parts.length > 0) sendInput(parts.join(''))
    return parts.length
  }

  // Alt-screen: whole lines → key sequences, in LINE mode on purpose: the
  // resolver's trackpad damping only applies to PIXEL deltas and is a
  // pointer-device fix that would otherwise eat ~70% of every touch delta.
  const scrollAlternateByPixels = (dy: number): boolean => {
    alternatePartialLines += dy / cellHeightPx
    const lines = Math.trunc(alternatePartialLines)
    alternatePartialLines %= 1
    if (lines === 0) return false
    const cap =
      profile === 'claude' || profile === 'codex' || profile === 'opencode'
        ? MAX_PAGES_PER_FLUSH
        : MAX_ARROWS_PER_FLUSH
    // Lines beyond the cap are dropped, not queued — a backlog that keeps
    // scrolling after the finger stopped feels worse than losing distance.
    return emitAlternateLines(lines < 0 ? -1 : 1, Math.min(Math.abs(lines), cap)) > 0
  }

  const scrollByPixels = (dy: number): { moved: boolean; normalBuffer: boolean } => {
    const bufferType = terminal.buffer?.active?.type
    if (bufferType !== lastBufferType) {
      normalPartialLines = 0
      alternatePartialLines = 0
      lastBufferType = bufferType
      clearSubLine()
    }
    if (bufferType === 'alternate') {
      return { moved: scrollAlternateByPixels(dy), normalBuffer: false }
    }
    const viewportResult = scrollViewportByPixels(dy)
    const moved = viewportResult === 'moved' || scrollLineFallback(dy)
    return { moved, normalBuffer: true }
  }

  // touchmove only accumulates; the scroll itself lands once per frame so a
  // 120Hz digitizer doesn't double-drive layout + xterm rendering.
  const flushPending = (): void => {
    flushFrame = null
    const dy = pendingDy
    pendingDy = 0
    if (dy === 0) return
    normalBufferPan = scrollByPixels(dy).normalBuffer
  }

  const scheduleFlush = () => {
    if (flushFrame !== null) return
    flushFrame = window.requestAnimationFrame(flushPending)
  }

  const pushSample = (t: number, y: number) => {
    samples.push({ t, y })
    if (samples.length > FLICK_SAMPLE_CAP) samples.shift()
  }

  // Velocity of the last ~100ms of finger travel. (firstY - lastY) keeps the
  // same sign convention as dy = lastY - y above.
  const flickVelocity = (endT: number): number => {
    const cutoff = endT - FLICK_SAMPLE_WINDOW_MS
    const recent = samples.filter((s) => s.t >= cutoff)
    const first = recent[0]
    const last = recent[recent.length - 1]
    if (!first || !last || first === last) return 0
    const dt = last.t - first.t
    if (dt <= 0) return 0
    const v = (first.y - last.y) / dt
    return Math.max(-MOMENTUM_MAX_VELOCITY_PX_PER_MS, Math.min(MOMENTUM_MAX_VELOCITY_PX_PER_MS, v))
  }

  // Alt-screen coast: drain a fixed line budget a couple per frame. Reuses
  // momentumFrame so stopMomentum() (cleanup / touchcancel / next touchstart)
  // cancels it the same way; any guard tripping inside emitAlternateLines
  // (buffer back to normal, mouse tracking, partial emit) ends the coast.
  let altGlideLines = 0
  const runAltGlide = () => {
    momentumFrame = null
    if (altGlideLines === 0) return
    if (terminal.buffer?.active?.type !== 'alternate') {
      altGlideLines = 0
      return
    }
    const step: 1 | -1 = altGlideLines > 0 ? 1 : -1
    const count = Math.min(Math.abs(altGlideLines), ALT_GLIDE_LINES_PER_FRAME)
    const emitted = emitAlternateLines(step, count)
    if (emitted < count) {
      altGlideLines = 0
      return
    }
    altGlideLines -= step * count
    if (altGlideLines !== 0) momentumFrame = window.requestAnimationFrame(runAltGlide)
  }

  const runMomentum = (now: number) => {
    const dt = Math.min(32, Math.max(1, now - lastMomentumAt))
    lastMomentumAt = now
    const { moved, normalBuffer } = scrollByPixels(velocityPxPerMs * dt)
    // Stop on the top/bottom edge AND if the buffer flipped to alternate
    // mid-glide — momentum must never turn into a key-sequence flood.
    if (!moved || !normalBuffer) {
      momentumFrame = null
      normalPartialLines = 0
      velocityPxPerMs = 0
      settleSubLine()
      return
    }
    velocityPxPerMs *= MOMENTUM_DECAY_PER_FRAME ** (dt / 16.67)
    if (Math.abs(velocityPxPerMs) < MOMENTUM_STOP_VELOCITY_PX_PER_MS) {
      momentumFrame = null
      normalPartialLines = 0
      settleSubLine()
      return
    }
    momentumFrame = window.requestAnimationFrame(runMomentum)
  }

  const onTouchStart = (event: TouchEvent) => {
    stopMomentum()
    altGlideLines = 0
    cancelFlush()
    pendingDy = 0
    samples = []
    // Single-finger only — leave multi-touch to the browser (zoom is locked
    // anyway, but don't fight whatever gesture it maps).
    lastY = event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null
    if (lastY !== null) pushSample(event.timeStamp, lastY)
    velocityPxPerMs = 0
    normalBufferPan = false
    resolveViewport()
    measureCellHeight()
  }

  const onTouchMove = (event: TouchEvent) => {
    if (lastY === null || event.touches.length !== 1) return
    const y = event.touches[0]?.clientY ?? lastY
    const dy = lastY - y
    // Sub-pixel jitter isn't a scroll — and NOT preventing default here keeps
    // a plain tap (focus → keyboard) working.
    if (Math.abs(dy) < 1) return
    lastY = y
    event.preventDefault()
    pendingDy += dy
    pushSample(event.timeStamp, y)
    scheduleFlush()
  }

  const onTouchEnd = (event: TouchEvent) => {
    lastY = null
    // Land any not-yet-flushed travel BEFORE deciding on momentum, so the
    // glide hands off from exactly where the finger left the content.
    cancelFlush()
    flushPending()
    const v = flickVelocity(event.timeStamp)
    samples = []
    if (normalBufferPan && Math.abs(v) >= MOMENTUM_MIN_VELOCITY_PX_PER_MS) {
      velocityPxPerMs = v
      lastMomentumAt = performance.now()
      momentumFrame = window.requestAnimationFrame(runMomentum)
      return
    }
    // Alt-screen flick → bounded coast (default profile only; a PgUp per
    // coast step would jump a screenful at a time).
    if (
      !normalBufferPan &&
      profile !== 'claude' &&
      profile !== 'opencode' &&
      Math.abs(v) >= ALT_GLIDE_MIN_VELOCITY_PX_PER_MS &&
      terminal.buffer?.active?.type === 'alternate'
    ) {
      const lines = Math.min(
        ALT_GLIDE_MAX_LINES,
        Math.round((Math.abs(v) * ALT_GLIDE_TRAVEL_MS) / cellHeightPx)
      )
      if (lines > 0) {
        altGlideLines = v > 0 ? lines : -lines
        momentumFrame = window.requestAnimationFrame(runAltGlide)
        return
      }
    }
    velocityPxPerMs = 0
    normalPartialLines = 0
    settleSubLine()
  }

  const onTouchCancel = () => {
    stopMomentum()
    altGlideLines = 0
    cancelFlush()
    pendingDy = 0
    samples = []
    lastY = null
    normalPartialLines = 0
    alternatePartialLines = 0
    velocityPxPerMs = 0
    normalBufferPan = false
    clearSubLine()
  }

  element.addEventListener('touchstart', onTouchStart, { passive: true })
  // passive: false — we preventDefault real pans so the page doesn't also move.
  element.addEventListener('touchmove', onTouchMove, { passive: false })
  element.addEventListener('touchend', onTouchEnd, { passive: true })
  element.addEventListener('touchcancel', onTouchCancel, { passive: true })

  return () => {
    element.removeEventListener('touchstart', onTouchStart)
    element.removeEventListener('touchmove', onTouchMove)
    element.removeEventListener('touchend', onTouchEnd)
    element.removeEventListener('touchcancel', onTouchCancel)
    stopMomentum()
    cancelFlush()
    // The screen element outlives this attachment — never leave a stale
    // sub-line transform on it.
    clearSubLine()
  }
}
