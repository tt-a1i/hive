import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  assertCommandIsExecutable,
  resolveCommandPath,
} from '../../src/server/agent-command-resolver.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('agent command resolver', () => {
  test('accepts executable commands already present on PATH', () => {
    expect(() =>
      assertCommandIsExecutable(process.execPath, process.cwd(), process.env)
    ).not.toThrow()
  })

  test('uses PATHEXT candidates before extensionless scripts on Windows', () => {
    if (process.platform !== 'win32') return

    const root = mkdtempSync(join(tmpdir(), 'hive-command-resolver-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'agent'), 'extensionless placeholder')
    writeFileSync(join(binDir, 'agent.cmd'), '@echo off\r\n')

    const resolved = resolveCommandPath('agent', root, {
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      PATHEXT: '.CMD;.EXE',
    })
    expect(resolved.toLowerCase()).toBe(join(binDir, 'agent.cmd').toLowerCase())
  })
})
