import { describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createImmediateInteractiveInputWriter } from '../../src/server/post-start-input-writer.js'

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

describe('PTY paste sanitization', () => {
  test('embedded bracketed-paste terminator is stripped before the real PTY write', async () => {
    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'paste-sanitize',
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.setRawMode(true); let received=""; process.stdin.on("data",c=>{received+=c.toString("utf8"); process.stdout.write("BODY:"+received.split("\\x1b[201~").join("|END|").split("\\x1b[200~").join("|START|")+"\\r\\n")}); process.stdin.resume(); process.stdout.write("PASTE_READY\\r\\n"); setInterval(()=>{}, 1<<30)',
      ],
      cwd: process.cwd(),
      env: process.env,
    })
    try {
      await waitFor(() => expect(manager.getRun(run.runId).output).toContain('PASTE_READY'))
      const write = createImmediateInteractiveInputWriter(manager, 'pi')
      const evil = 'keep-me\u001b[201~TRAILING'
      const done = write(run.runId, evil)
      await waitFor(() => {
        const output = manager.getRun(run.runId).output
        expect(output).toContain('BODY:|START|keep-meTRAILING|END|')
      })
      await done
    } finally {
      manager.stopRun(run.runId)
      manager.removeRun(run.runId)
    }
  })

  test('Gemini-style writes do not send an embedded CR as Enter', async () => {
    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'gemini-cr',
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.on("data",c=>{process.stdout.write("BODY:"+JSON.stringify(c.toString("utf8"))+"\\n")}); process.stdin.resume(); setInterval(()=>{}, 1<<30)',
      ],
      cwd: process.cwd(),
      env: process.env,
    })
    try {
      const write = createImmediateInteractiveInputWriter(manager, 'gemini')
      void write(run.runId, 'line one\rline two')
      await waitFor(() => {
        const output = manager.getRun(run.runId).output
        expect(output).toContain('line oneline two')
        expect(output).not.toContain('line one\rline two')
      })
    } finally {
      manager.stopRun(run.runId)
      manager.removeRun(run.runId)
    }
  })
})
