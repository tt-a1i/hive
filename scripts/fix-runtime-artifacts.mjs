import { chmodSync, existsSync } from 'node:fs'

const executablePaths = [
  'bin/team',
  'node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
]

for (const filePath of executablePaths) {
  if (!existsSync(filePath)) {
    continue
  }

  chmodSync(filePath, 0o755)
}
