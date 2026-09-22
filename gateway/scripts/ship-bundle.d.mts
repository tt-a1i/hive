import type { BundleManifest, BundleManifestEntry } from '../../scripts/gateway-bundle-manifest.mjs'

export interface ShipManifest {
  version: string
  entries: (BundleManifestEntry & { isEntry: boolean })[]
}

export function detectEntryUrls(distDir: string): Set<string>
export function buildShipManifest(distDir: string, version: string): ShipManifest
export function buildUploadPlan(
  distDir: string,
  version: string
): { version: string; files: { file: string; key: string; contentType: string }[] }
export function renderGeneratedModule(manifest: {
  version: string
  entries: (BundleManifestEntry & { isEntry?: boolean })[]
}): string
export function collectBakedAssets(
  distDir: string,
  manifest: BundleManifest
): { url: string; rel: string }[]
export function renderBakedAssetsModule(distDir: string, manifest: BundleManifest): string
