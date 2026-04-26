import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { pickFolder, type RunPickCommand } from '../../src/server/fs-pick-folder.js'

let sandboxRoot = ''
let insideDir = ''
let outsideRoot = ''
let outsideDir = ''
const tempDirs: string[] = []

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-pickfolder-root-'))
  outsideRoot = mkdtempSync(join(tmpdir(), 'hive-pickfolder-outside-'))
  tempDirs.push(sandboxRoot, outsideRoot)
  insideDir = join(sandboxRoot, 'alpha-project')
  outsideDir = join(outsideRoot, 'secret')
  mkdirSync(join(insideDir, '.git'), { recursive: true })
  writeFileSync(join(insideDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(outsideDir, { recursive: true })
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot
  delete process.env.HIVE_MOCK_PICK_FOLDER
})

afterEach(() => {
  delete process.env.HIVE_FS_BROWSE_ROOT
  delete process.env.HIVE_MOCK_PICK_FOLDER
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const emptySpawn = {
  spawnError: null,
  signal: null,
  stderr: '',
  stdout: '',
  status: 0 as number | null,
  timedOut: false,
}

describe('pickFolder — platform dispatch', () => {
  test('darwin: osascript stdout path flows through probeDirectory and returns probe.ok', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const runCommand: RunPickCommand = async (command, args) => {
      calls.push({ command, args })
      return { ...emptySpawn, stdout: `${insideDir}\n` }
    }
    const result = await pickFolder({ platform: 'darwin', runCommand })
    expect(result.canceled).toBe(false)
    expect(result.supported).toBe(true)
    expect(result.path).toBe(insideDir)
    expect(result.probe?.ok).toBe(true)
    expect(result.probe?.is_git_repository).toBe(true)
    expect(calls[0]?.command).toBe('osascript')
    expect(calls[0]?.args[0]).toBe('-e')
  })

  test('darwin: user cancel (exit code 1 + -1743) yields canceled=true silently', async () => {
    const runCommand: RunPickCommand = async () => ({
      ...emptySpawn,
      status: 1,
      stderr: '24:45: execution error: User canceled. (-1743)',
    })
    const result = await pickFolder({ platform: 'darwin', runCommand })
    expect(result.canceled).toBe(true)
    expect(result.error).toBeNull()
    expect(result.path).toBeNull()
    expect(result.supported).toBe(true)
  })

  test('linux: zenity stdout path flows through probeDirectory', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const runCommand: RunPickCommand = async (command, args) => {
      calls.push({ command, args })
      return { ...emptySpawn, stdout: `${insideDir}\n` }
    }
    const result = await pickFolder({ platform: 'linux', runCommand })
    expect(result.path).toBe(insideDir)
    expect(result.probe?.is_git_repository).toBe(true)
    expect(calls[0]?.command).toBe('zenity')
    expect(calls[0]?.args).toContain('--directory')
  })

  test('linux: zenity cancel (exit 1) is canceled, not an error', async () => {
    const runCommand: RunPickCommand = async () => ({ ...emptySpawn, status: 1 })
    const result = await pickFolder({ platform: 'linux', runCommand })
    expect(result.canceled).toBe(true)
    expect(result.error).toBeNull()
  })

  test('win32 (and other platforms): returns supported=false with guidance', async () => {
    const result = await pickFolder({ platform: 'win32' })
    expect(result.supported).toBe(false)
    expect(result.canceled).toBe(false)
    expect(result.error).toMatch(/Advanced: paste path/)
    expect(result.path).toBeNull()
  })

  test('missing binary (ENOENT) flips supported=false so the UI falls back', async () => {
    const runCommand: RunPickCommand = async () => ({
      ...emptySpawn,
      status: 127,
      spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    })
    const result = await pickFolder({ platform: 'linux', runCommand })
    expect(result.supported).toBe(false)
    expect(result.canceled).toBe(false)
  })

  test('picked path outside the sandbox is rejected by probeDirectory', async () => {
    const runCommand: RunPickCommand = async () => ({ ...emptySpawn, stdout: `${outsideDir}\n` })
    const result = await pickFolder({ platform: 'darwin', runCommand })
    expect(result.path).toBe(outsideDir)
    expect(result.probe?.ok).toBe(false)
    expect(result.error).toMatch(/outside the Hive browse sandbox/)
  })

  test('timeout is surfaced as canceled with an informative error', async () => {
    const runCommand: RunPickCommand = async () => ({
      ...emptySpawn,
      status: null,
      signal: 'SIGTERM',
      timedOut: true,
    })
    const result = await pickFolder({ platform: 'darwin', runCommand })
    expect(result.canceled).toBe(true)
    expect(result.error).toMatch(/timed out/)
  })
})

describe('pickFolder — HIVE_MOCK_PICK_FOLDER smoke hook', () => {
  test('mock path short-circuits the native picker and still runs probeDirectory', async () => {
    process.env.HIVE_MOCK_PICK_FOLDER = insideDir
    const result = await pickFolder({ platform: 'darwin' })
    expect(result.path).toBe(insideDir)
    expect(result.probe?.ok).toBe(true)
  })

  test('__cancel__ sentinel yields canceled=true', async () => {
    process.env.HIVE_MOCK_PICK_FOLDER = '__cancel__'
    const result = await pickFolder()
    expect(result.canceled).toBe(true)
  })

  test('__unsupported__ sentinel yields supported=false', async () => {
    process.env.HIVE_MOCK_PICK_FOLDER = '__unsupported__'
    const result = await pickFolder()
    expect(result.supported).toBe(false)
  })
})
