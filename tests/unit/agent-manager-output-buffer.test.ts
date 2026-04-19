import '../helpers/mock-node-pty.ts'

import { describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'

describe('agent manager output buffer (unit)', () => {
  test('caps output at 1MB while collecting PTY data', async () => {
    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'agent-1',
      command: '/bin/bash',
      args: ['huge-output.js'],
      cwd: '/tmp',
      env: {},
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    const snapshot = manager.getRun(run.runId)
    expect(snapshot.output.length).toBeLessThanOrEqual(1_000_000)
    expect(snapshot.output.slice(-100)).toBe('z'.repeat(100))
  })
})
