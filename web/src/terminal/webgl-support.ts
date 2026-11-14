/**
 * Honest WebGL detection so the terminal picks a renderer it can actually use.
 * Some mobile browsers expose no stable WebGL context; loading @xterm/addon-webgl
 * there white-screens the terminal. We probe a throwaway canvas before loading
 * the addon and fall back to xterm's default canvas renderer when WebGL is
 * absent. The canvas factory is injectable so the check is testable in jsdom.
 */

let cachedSupport: boolean | undefined

export const detectWebglSupport = (createCanvas?: () => HTMLCanvasElement | null): boolean => {
  if (!createCanvas && cachedSupport !== undefined) return cachedSupport
  const probe =
    createCanvas ??
    (() => (typeof document !== 'undefined' ? document.createElement('canvas') : null))
  const canvas = probe()
  let supported = false
  try {
    const context = canvas?.getContext?.('webgl2') || canvas?.getContext?.('webgl')
    supported = Boolean(context)
    context?.getExtension?.('WEBGL_lose_context')?.loseContext()
  } catch {
    // A failed probe leaves the default renderer in use.
  }
  if (!createCanvas) cachedSupport = supported
  return supported
}
