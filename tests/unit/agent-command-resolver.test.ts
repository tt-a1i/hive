import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  assertCommandIsExecutable,
  resolveCommandPath,
  resolveSpawnCommand,
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
    const root = mkdtempSync(join(tmpdir(), 'hive-command-resolver-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'agent'), 'extensionless placeholder')
    writeFileSync(join(binDir, 'agent.cmd'), '@echo off\r\n')

    const resolved = resolveCommandPath(
      'agent',
      root,
      {
        Path: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        PathExt: '.cmd;.EXE',
      },
      'win32'
    )
    expect(resolved.toLowerCase()).toBe(join(binDir, 'agent.cmd').toLowerCase())
  })

  test('wraps Windows command shims with cmd.exe for PTY spawn', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-spawn-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    const commandPath = join(binDir, 'agent.cmd')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(commandPath, '@echo off\r\n')

    const resolved = resolveSpawnCommand(
      'agent',
      root,
      {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        Path: binDir,
        PathExt: '.cmd;.EXE',
      },
      ['--flag', 'value with spaces'],
      'win32'
    )

    expect(resolved).toEqual({
      args: ['/d', '/s', '/c', `"${commandPath}" "--flag" "value with spaces"`],
      command: 'C:\\Windows\\System32\\cmd.exe',
    })
  })
})
