import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = '@tt-a1i/hive'

export const readPackageVersion = () => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string') return parsed.version
    }
    dir = dirname(dir)
  }
  return 'unknown'
}
