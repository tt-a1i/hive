export const shouldUseGatewayBundle = (host: string, bundleMode: string | undefined): boolean => {
  // Loopback is always the local runtime, even if a stale gateway flag leaks into a developer shell.
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') {
    return false
  }

  // An explicit build mode is authoritative for non-loopback origins. This lets a self-hosted or
  // LAN-served runtime remain on DirectTransport without weakening the safe gateway fallback.
  if (bundleMode === '1') return true
  if (bundleMode === '0') return false

  return true
}

// Decides which transport the bundle boots with. Consumed by M5b's mobile entry; the desktop entry
// never calls this (directTransport is the default in api.ts). M5a delivers the seam + default only.
export const isGatewayServedBundle = (): boolean =>
  shouldUseGatewayBundle(window.location.hostname, import.meta.env.VITE_HIVE_GATEWAY_BUNDLE)
