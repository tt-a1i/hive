import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const executablePaths = [
  'bin/team',
  'bin/team.cmd',
  'dist/bin/team',
  'dist/bin/team.cmd',
  'node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
]

const require = createRequire(import.meta.url)

try {
  const nodePtyPackageJson = require.resolve('node-pty/package.json')
  const nodePtyRoot = dirname(nodePtyPackageJson)
  const prebuildsDir = join(nodePtyRoot, 'prebuilds')

  for (const entry of existsSync(prebuildsDir) ? readdirSync(prebuildsDir) : []) {
    executablePaths.push(join(prebuildsDir, entry, 'spawn-helper'))
  }
} catch {
  // node-pty may not be installed when this script runs in partial dev setups.
}

for (const filePath of executablePaths) {
  if (!existsSync(filePath)) {
    continue
  }

  chmodSync(filePath, 0o755)
}
