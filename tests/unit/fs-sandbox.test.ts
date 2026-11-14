import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { isPathWithinRoot } from '../../src/server/fs-sandbox.js'

test.skipIf(process.platform === 'win32')(
  'checks the real existing ancestor for a future path',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-path-root-'))
    const other = mkdtempSync(join(tmpdir(), 'hive-path-other-'))
    try {
      mkdirSync(join(root, 'safe'))
      symlinkSync(other, join(root, 'outside'))
      expect(isPathWithinRoot(root, join(root, 'safe', 'new', 'child'))).toBe(true)
      expect(isPathWithinRoot(root, join(root, 'outside', 'new', 'child'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  }
)
