import { createRequire } from 'node:module'
import { spawn as platformSpawn } from '@lydell/node-pty'

// Ship the reviewed Windows JS lifecycle fix without redistributing native
// binaries or mutating installed dependencies. Unix keeps its original backend.
export const spawn: typeof platformSpawn =
  process.platform === 'win32'
    ? createRequire(import.meta.url)('../../vendor/node-pty-windows/lib/index.js').spawn
    : platformSpawn
