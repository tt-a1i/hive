import { PACKAGE_NAME, readPackageVersion } from './package-version.js'

export interface VersionInfoPayload {
  current_version: string
  install_hint: string
  latest_version: string
  package_name: string
  release_url: string
  update_available: boolean
}

export interface VersionService {
  getVersionInfo: () => Promise<VersionInfoPayload>
}

type NpmPackageMetadata = {
  version?: unknown
}

const VERSION_CACHE_MS = 6 * 60 * 60 * 1000
const REGISTRY_URL = 'https://registry.npmjs.org/@tt-a1i%2Fhive/latest'

const parseVersion = (version: string) => {
  const [core = '', prerelease = ''] = version.split('-', 2)
  const [major = 0, minor = 0, patch = 0] = core.split('.').map((part) => Number.parseInt(part, 10))
  return {
    core: [major || 0, minor || 0, patch || 0],
    prerelease,
  }
}

export const compareVersions = (left: string, right: string) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (delta !== 0) return delta
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true })
}

const buildVersionInfo = (currentVersion: string, latestVersion: string): VersionInfoPayload => ({
  current_version: currentVersion,
  install_hint: `npm update -g ${PACKAGE_NAME}`,
  latest_version: latestVersion,
  package_name: PACKAGE_NAME,
  release_url: `https://www.npmjs.com/package/${PACKAGE_NAME}/v/${latestVersion}`,
  update_available: compareVersions(latestVersion, currentVersion) > 0,
})

export const createVersionService = (
  options: { fetchLatestVersion?: () => Promise<string>; now?: () => number } = {}
): VersionService => {
  const currentVersion = readPackageVersion()
  const now = options.now ?? Date.now
  const fetchLatestVersion =
    options.fetchLatestVersion ??
    (async () => {
      const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(1500) })
      if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
      const body = (await response.json()) as NpmPackageMetadata
      if (typeof body.version !== 'string' || !body.version.trim()) {
        throw new Error('npm registry response did not include a version')
      }
      return body.version
    })

  let cached: { expiresAt: number; info: VersionInfoPayload } | null = null

  return {
    getVersionInfo: async () => {
      const currentTime = now()
      if (cached && cached.expiresAt > currentTime) return cached.info
      try {
        const latestVersion = await fetchLatestVersion()
        const info = buildVersionInfo(currentVersion, latestVersion)
        cached = { expiresAt: currentTime + VERSION_CACHE_MS, info }
        return info
      } catch {
        const info = buildVersionInfo(currentVersion, currentVersion)
        cached = { expiresAt: currentTime + VERSION_CACHE_MS, info }
        return info
      }
    },
  }
}
