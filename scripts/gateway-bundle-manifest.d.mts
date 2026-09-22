import type { BinaryLike } from 'node:crypto'

export interface BundleManifestEntry {
  kind: 'script' | 'style'
  url: string
  integrity: string
}

export interface BundleManifest {
  version: string
  entries: BundleManifestEntry[]
}

export function sriIntegrity(bytes: BinaryLike): string
export function buildManifest(distDir: string, version: string): BundleManifest
