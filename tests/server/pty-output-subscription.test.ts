import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'

const tempDirs: string[] = []

const waitFor = async (assertion: () => void, timeoutMs = 2000, intervalMs = 20) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('pty output subscription (real pty)', () => {
  test('subscribers receive PTY output chunks for a live run', async () => {
    const dir = join(tmpdir(), `hive-pty-output-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    tempDirs.push(dir)

    const scriptPath = join(dir, 'hello.js')
    writeFileSync(scriptPath, "setTimeout(() => { console.log('hello'); process.exit(0) }, 20)\n")

    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'worker-1',
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: {},
    })

    const received: string[] = []
    manager.getOutputBus().subscribe(run.runId, (chunk) => {
      received.push(chunk)
    })

    await waitFor(() => {
      expect(manager.getRun(run.runId).status).toBe('exited')
      expect(received.join('')).toContain('hello')
    })
  })
})
