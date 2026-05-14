import '@testing-library/jest-dom/vitest'

import { afterEach } from 'vitest'

// Node 25 ships an experimental localStorage that overrides jsdom's implementation
// but lacks standard methods (setItem, getItem, clear, removeItem). Polyfill when needed.
if (typeof window !== 'undefined' && typeof window.localStorage?.setItem !== 'function') {
  const store: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    writable: true,
    configurable: true,
    value: {
      getItem: (key: string) => (Object.hasOwn(store, key) ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = String(value)
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      get length() {
        return Object.keys(store).length
      },
      key: (idx: number) => Object.keys(store)[idx] ?? null,
    },
  })
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
      }) as MediaQueryList,
  })
}

const createCanvasContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D =>
  ({
    canvas,
    clearRect: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    measureText: () => ({ width: 0 }),
  }) as unknown as CanvasRenderingContext2D

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement, contextId: string) {
      return contextId === '2d' ? createCanvasContext(this) : null
    },
  })
}

afterEach(() => {
  if (typeof document === 'undefined') return

  document.body.removeAttribute('data-scroll-locked')
  document.body.style.pointerEvents = ''
  document.querySelectorAll('[data-radix-focus-guard]').forEach((node) => {
    node.parentNode?.removeChild(node)
  })
})
