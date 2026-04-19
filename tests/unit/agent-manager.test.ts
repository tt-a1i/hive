import '../helpers/mock-node-pty.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'

const tempDirs: string[] = []

const waitFor = async (assertion: () => void, timeoutMs = 1000, intervalMs = 10) => {
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

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('agent manager (unit)', () => {
  test('starts a PTY process and captures output', async () => {
    const dir = join(tmpdir(), `hive-agent-${Date.now()}-start`)
    mkdirSync(dir, { recursive: true })
    tempDirs.push(dir)

    const scriptPath = join(dir, 'print-env.js')
    writeFileSync(
      scriptPath,
      [
        'console.log(process.env.HIVE_PROJECT_ID)',
        'console.log(process.env.HIVE_AGENT_ID)',
        'setTimeout(() => process.exit(0), 10)',
      ].join('\n')
    )

    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'worker-1',
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: {
        HIVE_PORT: '4010',
        HIVE_PROJECT_ID: 'workspace-1',
        HIVE_AGENT_ID: 'worker-1',
      },
    })

    await waitFor(() => {
      expect(manager.getRun(run.runId).status).toBe('exited')
    })

    const snapshot = manager.getRun(run.runId)

    expect(snapshot.status).toBe('exited')
    expect(snapshot.output).toContain('workspace-1')
    expect(snapshot.output).toContain('worker-1')
  })

  test('writes input into the running PTY', async () => {
    const dir = join(tmpdir(), `hive-agent-${Date.now()}-stdin`)
    mkdirSync(dir, { recursive: true })
    tempDirs.push(dir)

    const scriptPath = join(dir, 'echo-stdin.js')
    writeFileSync(
      scriptPath,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        '  process.exit(0)',
        '})',
      ].join('\n')
    )

    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'worker-2',
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: {
        HIVE_PORT: '4010',
        HIVE_PROJECT_ID: 'workspace-2',
        HIVE_AGENT_ID: 'worker-2',
      },
    })

    manager.writeInput(run.runId, 'hello from hive\n')
    await waitFor(() => {
      const snapshot = manager.getRun(run.runId)
      expect(snapshot.output).toContain('IN:hello from hive')
      expect(snapshot.status).toBe('exited')
    })

    const snapshot = manager.getRun(run.runId)

    expect(snapshot.output).toContain('IN:hello from hive')
    expect(snapshot.status).toBe('exited')
  })
})
