import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  prepareBuildArtifacts,
  withWindowsFsRetry,
} from '../../scripts/prepare-build-artifacts.mjs'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const AGENT_NAMES_FIXTURE = `${JSON.stringify(
  {
    names: [
      { name: '鸣人', category: 'anime', note: 'fixture' },
      { name: 'Tom Nook', category: 'game', note: 'fixture' },
    ],
  },
  null,
  2
)}\n`

const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-prepare-build-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  mkdirSync(join(dir, 'src', 'server'), { recursive: true })
  mkdirSync(join(dir, 'src', 'shared'), { recursive: true })
  mkdirSync(join(dir, 'vendor', 'marketplace', 'en'), { recursive: true })
  mkdirSync(join(dir, 'vendor', 'node-pty-windows', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'team'), '#!/usr/bin/env node\n')
  writeFileSync(join(dir, 'bin', 'team.cmd'), '@echo off\r\n')
  writeFileSync(join(dir, 'src', 'server', 'workflow-vm-worker.cjs'), 'worker\n')
  writeFileSync(join(dir, 'src', 'shared', 'agent-names.json'), AGENT_NAMES_FIXTURE)
  writeFileSync(join(dir, 'vendor', 'marketplace', 'en', 'agent.md'), '# Agent\n')
  writeFileSync(join(dir, 'vendor', 'node-pty-windows', 'lib', 'index.js'), 'fixture PTY JS\n')
  writeFileSync(join(dir, 'vendor', 'node-pty-windows', 'LICENSE'), 'fixture license\n')
  return dir
}

describe('prepare-build-artifacts', () => {
  test('copies required launchers and marketplace files into dist', () => {
    const root = makeRoot()

    prepareBuildArtifacts({ root })

    expect(readFileSync(join(root, 'dist', 'bin', 'team'), 'utf8')).toBe('#!/usr/bin/env node\n')
    expect(readFileSync(join(root, 'dist', 'bin', 'team.cmd'), 'utf8')).toBe('@echo off\r\n')
    expect(
      readFileSync(join(root, 'dist', 'src', 'server', 'workflow-vm-worker.cjs'), 'utf8')
    ).toBe('worker\n')
    expect(readFileSync(join(root, 'dist', 'src', 'shared', 'agent-names.json'), 'utf8')).toBe(
      AGENT_NAMES_FIXTURE
    )
    expect(
      readFileSync(join(root, 'dist', 'vendor', 'marketplace', 'en', 'agent.md'), 'utf8')
    ).toBe('# Agent\n')
    expect(
      readFileSync(join(root, 'dist', 'vendor', 'node-pty-windows', 'lib', 'index.js'), 'utf8')
    ).toBe('fixture PTY JS\n')
    expect(readFileSync(join(root, 'dist', 'vendor', 'node-pty-windows', 'LICENSE'), 'utf8')).toBe(
      'fixture license\n'
    )
  })

  test('replaces a stale marketplace dist directory before copying', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'dist', 'vendor', 'marketplace', 'old'), { recursive: true })
    writeFileSync(join(root, 'dist', 'vendor', 'marketplace', 'old', 'stale.md'), 'stale')

    prepareBuildArtifacts({ root })

    expect(existsSync(join(root, 'dist', 'vendor', 'marketplace', 'old', 'stale.md'))).toBe(false)
    expect(existsSync(join(root, 'dist', 'vendor', 'marketplace', 'en', 'agent.md'))).toBe(true)
  })

  test('retries transient Windows filesystem errors', () => {
    const sleep = vi.fn()
    const operation = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      })
      .mockReturnValue('ok')

    expect(
      withWindowsFsRetry('copy dist', operation, {
        platform: 'win32',
        retryDelayMs: 7,
        sleep,
      })
    ).toBe('ok')

    expect(operation).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(7)
  })

  test('does not retry non-Windows filesystem errors', () => {
    const operation = vi.fn(() => {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    })

    expect(() => withWindowsFsRetry('copy dist', operation, { platform: 'linux' })).toThrow(
      /locked/
    )
    expect(operation).toHaveBeenCalledTimes(1)
  })
})
