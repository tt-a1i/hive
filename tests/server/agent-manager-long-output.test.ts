import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createImmediateInteractiveInputWriter } from '../../src/server/post-start-input-writer.js'

const script = fileURLToPath(new URL('../fixtures/terminal/long-output-paste.cjs', import.meta.url))

test.each([
  'ack',
  'late',
])('real PTY submits after 1MB output: %s acknowledgement', async (mode) => {
  const manager = createAgentManager()
  const run = await manager.startAgent({
    agentId: `long-output-${mode}`,
    command: process.execPath,
    args: [script, mode],
    cwd: process.cwd(),
  })
  let observedLength = run.totalOutputLength ?? 0
  const unsubscribe = manager.getOutputBus().subscribe(run.runId, (chunk) => {
    observedLength += chunk.length
  })
  try {
    await expect
      .poll(() => manager.getRun(run.runId).output, { timeout: 5000 })
      .toContain('LONG_OUTPUT_READY')
    const before = manager.getRun(run.runId)
    expect(before.output).toHaveLength(1_000_000)
    expect(before.output).toContain('[Pasted Content 2400 chars]')
    expect(before.totalOutputLength).toBeGreaterThan(1_100_000)
    expect(before.totalOutputLength).toBe(observedLength)
    const text = `<hive-message kind="dispatch">${'a'.repeat(2400)}</hive-message>`
    const done = createImmediateInteractiveInputWriter(manager, 'codex')(run.runId, text)
    const submits = mode === 'late' ? 2 : 1
    await expect
      .poll(() => manager.getRun(run.runId).output, { timeout: mode === 'late' ? 15000 : 7000 })
      .toContain(`SUBMITTED:${submits}:${Buffer.from(text).toString('hex')}`)
    await done
    const after = manager.getRun(run.runId)
    expect(after.output).toHaveLength(1_000_000)
    expect(after.totalOutputLength).toBeGreaterThan(before.totalOutputLength ?? 0)
    expect(after.totalOutputLength).toBe(observedLength)
  } finally {
    unsubscribe()
    manager.stopRun(run.runId)
    await expect.poll(() => manager.getRun(run.runId).status).toMatch(/^(exited|error)$/)
    manager.removeRun(run.runId)
  }
}, 25000)
