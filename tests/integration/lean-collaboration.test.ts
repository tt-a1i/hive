import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const execute = promisify(execFile)
const cwd = fileURLToPath(new URL('../../', import.meta.url))

// The programs own the real HTTP/SQLite/PTY assertions. The parent owns their
// temporary root so a child timeout cannot bypass cleanup with process.exit.
const runScenario = async (script: string, args: string[], receipt: string) => {
  const root = await mkdtemp(join(tmpdir(), 'hive-lean-suite-'))
  try {
    const { stdout } = await execute(
      process.execPath,
      ['--import', 'tsx', `scripts/${script}`, ...args],
      {
        cwd,
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
        timeout: 150000,
        maxBuffer: 2 * 1024 * 1024,
      }
    )
    expect(stdout).toContain(receipt)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('CLI/HTTP/SQLite/PTY collaboration survives recovery and cancellation', async () => {
  await runScenario('check-lean-communication.ts', [], 'PASS: ask/reply, mailbox ACK races/restart')
}, 180000)

test('v45 migration and mailbox/outcome persistence survive database reopen', async () => {
  await runScenario(
    'check-lean-persistence.ts',
    ['--storage-only'],
    'PASS: v45 migration preserves legacy unknown outcome; batch/outcome survive reopen'
  )
}, 180000)

// This fixture uses a POSIX launcher; storage and member CLI scenarios above
// remain enabled on Windows. Do not let PATH fall through to a user's Codex.
test.skipIf(process.platform === 'win32')(
  'MCP reply replay and external-controller rebinding',
  async () => {
    await runScenario(
      'check-lean-persistence.ts',
      [],
      'MCP reply replay; external outcome receipt; rebind closes retired question'
    )
  },
  180000
)
