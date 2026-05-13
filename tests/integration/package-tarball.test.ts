import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

interface PackFile {
  path: string
}

interface PackResult {
  files: PackFile[]
  name: string
  version: string
}

describe('npm package tarball', () => {
  test('publish dry-run exposes only runtime files and the hive bin', () => {
    expect(existsSync(join(process.cwd(), 'dist', 'src', 'cli', 'hive.js'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'web', 'dist', 'index.html'))).toBe(true)

    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const [result] = JSON.parse(output) as PackResult[]
    const paths = result.files.map((file) => file.path)

    expect(result.name).toBe('@tt-a1i/hive')
    expect(result.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(paths).toContain('dist/src/cli/hive.js')
    expect(paths).toContain('dist/src/cli/team.js')
    expect(paths).toContain('dist/bin/team')
    expect(paths).toContain('web/dist/index.html')
    expect(paths).toContain('scripts/fix-runtime-artifacts.mjs')
    expect(paths).toContain('CHANGELOG.md')
    expect(paths).toContain('LICENSE')
    expect(paths).toContain('README.md')
    expect(paths).toContain('SECURITY.md')

    expect(paths.some((path) => path.startsWith('src/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('tests/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('web/src/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('dist/tests/'))).toBe(false)
    expect(paths).not.toContain('AGENTS.md')
    expect(paths).not.toContain('CLAUDE.md')
    expect(paths).not.toContain('TODO.md')
    expect(paths).not.toContain('bin/team')
  })

  test('published tarball installs and starts the packaged runtime', () => {
    execFileSync(process.execPath, ['scripts/pack-smoke.mjs'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
  }, 120_000)
})
