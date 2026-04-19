import { readFileSync, statSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

describe('runtime artifacts', () => {
  test('bin/team source script is executable and points to runtime output', () => {
    const mode = statSync('bin/team').mode & 0o111
    const source = readFileSync('bin/team', 'utf8')

    expect(mode).not.toBe(0)
    expect(source).toContain('../src/cli/team.js')
    expect(source).not.toContain('../dist/src/cli/team.js')
  })

  test('node-pty spawn-helper is executable after install', () => {
    const mode =
      statSync(
        'node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'
      ).mode & 0o111

    expect(mode).not.toBe(0)
  })
})
