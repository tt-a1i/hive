import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// The executable JavaScript checker has no separate TypeScript declaration.
// @ts-expect-error -- tested directly as an ES module
import { checkFile } from '../../scripts/check-engineering.mjs'

const script = resolve('scripts/check-engineering.mjs')
const dirs: string[] = []
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'hive-policy-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'])
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
  execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', '.git/no-hooks'])
  return dir
}
function write(dir: string, path: string, content: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), content)
}
function commit(dir: string) {
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'base'])
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}
function run(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' })
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('engineering policy checker', () => {
  it.each([
    ['tests/server/import.test.ts', "import '../mock-node-pty'"],
    ['tests/cli/export.test.ts', "export * from '../mock-node-pty'"],
    ['tests/integration/dynamic.test.ts', "import('../mock-node-pty')"],
    ['tests/server/require.test.ts', "require('../mock-node-pty')"],
    ['tests/server/mock.test.ts', "vi.mock('node-pty')"],
    ['tests/cli/scoped.test.ts', "vi.mock('@lydell/node-pty')"],
    ['tests/integration/domock.test.ts', "vi.doMock('@lydell/node-pty')"],
    [
      'tests/server/spy.test.ts',
      "import * as pty from '@lydell/node-pty'; vi.spyOn(pty, 'spawn').mockReturnValue(fake)",
    ],
    ['tests/cli/assignment.test.ts', "import pty from 'node-pty'; pty.spawn = vi.fn()"],
    [
      'tests/integration/require-spy.test.ts',
      "const pty = require('node-pty'); vi.spyOn(pty, 'spawn')",
    ],
    [
      'tests/integration/dynamic-spy.test.ts',
      "const pty = await import('@lydell/node-pty'); vi.spyOn(pty, 'spawn')",
    ],
    ['src/id.ts', 'const id = Math.random().toString(36)'],
    ['web/src/id.ts', 'const id = Math . random ( ) . toString ( 36 )'],
    ['gateway/src/id.ts', 'const id = Math.random().toString(36)'],
  ])('rejects %s independently', (path, content) => {
    expect(checkFile(path, content, undefined)).toEqual([expect.stringContaining(path)])
  })
  it('accepts real PTY imports, crypto IDs, jitter, comments and unit mocks', () => {
    const fixtures = {
      'tests/server/real.test.ts': "import * as pty from '@lydell/node-pty'",
      'tests/server/process.test.ts':
        "import * as child from 'node:child_process'; vi.spyOn(child, 'spawn'); const x = {spawn: vi.fn()}; x.spawn = vi.fn()",
      'tests/unit/mock.test.ts': "vi.mock('node-pty')",
      'src/ok.ts':
        'const id = crypto.randomUUID(); const jitter = Math.random() * 100; // Math.random().toString(36)',
    }
    for (const [path, content] of Object.entries(fixtures))
      expect(checkFile(path, content, undefined)).toEqual([])
  })
  it('uses the supplied base to reject new large files and growth of existing large files', () => {
    const dir = repo()
    write(dir, 'src/existing.ts', 'x\n'.repeat(600))
    write(dir, 'src/unchanged.ts', 'x\n'.repeat(601))
    write(dir, 'src/shrink.ts', 'x\n'.repeat(603))
    const base = commit(dir)
    write(dir, 'src/existing.ts', 'x\n'.repeat(601))
    write(dir, 'src/new.ts', 'x\n'.repeat(501))
    write(dir, 'src/shrink.ts', 'x\n'.repeat(602))
    write(dir, 'src/small.ts', 'x\n'.repeat(500))
    write(dir, 'tests/server/mock.test.ts', "vi.mock('node-pty')")
    const result = run(dir, '--base', base)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('src/existing.ts')
    expect(result.stdout).toContain('src/new.ts')
    expect(result.stdout).toContain('tests/server/mock.test.ts: line 1: PTY module mock')
    expect(result.stdout).not.toContain('src/unchanged.ts')
    expect(result.stdout).not.toContain('src/shrink.ts')
    expect(result.stdout).not.toContain('src/small.ts')
    write(dir, 'src/existing.ts', 'x\n'.repeat(600))
    write(dir, 'src/new.ts', 'x\n'.repeat(500))
    write(dir, 'tests/server/mock.test.ts', "import * as pty from 'node-pty'")
    expect(run(dir, '--base', base).status).toBe(0)
  })
  it('fails when the requested base does not exist', () => {
    const dir = repo()
    write(dir, 'README.md', 'base')
    commit(dir)
    expect(run(dir, '--base', 'missing-ref').status).not.toBe(0)
  })
})
