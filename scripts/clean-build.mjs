import { rmSync } from 'node:fs'

for (const path of ['dist', 'web/dist']) {
  rmSync(path, { force: true, recursive: true })
}
