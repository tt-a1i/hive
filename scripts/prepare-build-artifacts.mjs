import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const distBin = join(root, 'dist', 'bin')

const copyRequired = (source, target, mode) => {
  const sourcePath = join(root, source)
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required build artifact source: ${source}`)
  }
  const targetPath = join(root, target)
  copyFileSync(sourcePath, targetPath)
  if (mode) chmodSync(targetPath, mode)
}

mkdirSync(distBin, { recursive: true })
copyRequired('bin/team', 'dist/bin/team', 0o755)
copyRequired('bin/team.cmd', 'dist/bin/team.cmd')
