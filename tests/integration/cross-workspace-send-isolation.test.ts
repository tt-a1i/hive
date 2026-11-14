import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { expandInboxReferences } from '../helpers/inbox.js'

const tempDirs: string[] = []
const originalDataDir = process.env.HIVE_DATA_DIR

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 2000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeTestPath(dir)
  }
})

describe('cross workspace send isolation', () => {
  test('team send Alice reaches only the current workspace Alice run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-send-isolation-'))
    tempDirs.push(dataDir)
    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0', '--no-open'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiSessionResponse = await fetch(`${baseUrl}/api/ui/session`)
      const uiCookie = uiSessionResponse.headers.get('set-cookie')
      if (!uiCookie) {
        throw new Error('Expected UI session cookie')
      }
      const workspaceAPath = join(dataDir, 'workspace-a')
      const workspaceBPath = join(dataDir, 'workspace-b')
      mkdirSync(workspaceAPath, { recursive: true })
      mkdirSync(workspaceBPath, { recursive: true })

      const workerScriptA = join(workspaceAPath, 'echo-a.js')
      const workerScriptB = join(workspaceBPath, 'echo-b.js')
      const receivedA = join(workspaceAPath, 'received.txt')
      const receivedB = join(workspaceBPath, 'received.txt')
      writeFileSync(receivedA, '')
      writeFileSync(receivedB, '')
      writeFileSync(
        workerScriptA,
        [
          "const { appendFileSync } = require('node:fs')",
          'process.stdin.setRawMode(true)',
          `process.stdin.on('data', c => { appendFileSync(${JSON.stringify(receivedA)}, c); process.stdout.write('A:' + c) })`,
        ].join('\n')
      )
      writeFileSync(
        workerScriptB,
        [
          "const { appendFileSync } = require('node:fs')",
          'process.stdin.setRawMode(true)',
          `process.stdin.on('data', c => appendFileSync(${JSON.stringify(receivedB)}, c))`,
          "process.stdout.write('B_RECEIVER_READY\\r\\n')",
        ].join('\n')
      )

      const createWorkspace = async (name: string, path: string) => {
        const response = await fetch(`${baseUrl}/api/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ autostart_orchestrator: false, name, path }),
        })
        expect(response.status).toBe(201)
        return (await response.json()) as { id: string }
      }

      const a = await createWorkspace('A', workspaceAPath)
      const b = await createWorkspace('B', workspaceBPath)
      expect(hive.store.listAgentRuns(`${a.id}:orchestrator`)).toEqual([])
      expect(hive.store.listAgentRuns(`${b.id}:orchestrator`)).toEqual([])

      const addWorker = async (workspaceId: string) => {
        const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ name: 'Alice', role: 'coder' }),
        })
        return (await response.json()) as { id: string }
      }

      const workerA = await addWorker(a.id)
      const workerB = await addWorker(b.id)

      const config = async (workspaceId: string, agentId: string, scriptPath: string) => {
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: process.execPath,
            args: [scriptPath],
          }),
        })
      }

      await config(a.id, workerA.id, workerScriptA)
      await config(b.id, workerB.id, workerScriptB)
      await config(a.id, `${a.id}:orchestrator`, workerScriptA)
      await config(b.id, `${b.id}:orchestrator`, workerScriptB)

      const start = async (workspaceId: string, agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({ hive_port: String(hive.port) }),
          }
        )
        const payload = (await response.json()) as { run_id: string }
        return { runId: payload.run_id }
      }

      const runA = await start(a.id, workerA.id)
      const runB = await start(b.id, workerB.id)
      await start(a.id, `${a.id}:orchestrator`)
      await start(b.id, `${b.id}:orchestrator`)
      await hive.store.getActiveRunByAgentId(b.id, workerB.id)?.postStartInputReady
      await waitFor(() => {
        expect(hive.store.getActiveRunByAgentId(b.id, workerB.id)?.output).toContain(
          'B_RECEIVER_READY'
        )
      })

      const sent = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: a.id,
          from_agent_id: `${a.id}:orchestrator`,
          token: hive.store.peekAgentToken(`${a.id}:orchestrator`),
          to: 'Alice',
          text: '实现登录',
        }),
      })
      expect(sent.ok).toBe(true)
      const ownTaskB = 'B_WORKSPACE_OWN_TASK'
      const sentB = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: b.id,
          from_agent_id: `${b.id}:orchestrator`,
          token: hive.store.peekAgentToken(`${b.id}:orchestrator`),
          to: 'Alice',
          text: ownTaskB,
        }),
      })
      expect(sentB.status).toBe(202)

      await waitFor(
        async () => {
          const responseA = await fetch(`${baseUrl}/api/runtime/runs/${runA.runId}`, {
            headers: { cookie: uiCookie },
          })
          const responseB = await fetch(`${baseUrl}/api/runtime/runs/${runB.runId}`, {
            headers: { cookie: uiCookie },
          })
          const bodyA = (await responseA.json()) as { output: string }
          const bodyB = (await responseB.json()) as { output: string }

          expect(bodyA.output).toContain('A:')
          expect(expandInboxReferences(bodyA.output)).toContain('@Orchestrator')
          expect(expandInboxReferences(bodyA.output)).toContain('实现登录')
          expect(bodyB.output).toContain('B_RECEIVER_READY')
          expect(expandInboxReferences(readFileSync(receivedA, 'utf8'))).toContain('实现登录')
          expect(expandInboxReferences(readFileSync(receivedB, 'utf8'))).toContain(ownTaskB)
        },
        2000,
        25
      )
      // Only assert absence after B has consumed a subsequent input barrier.
      // Raw child receipts are unaffected by terminal wrapping/repaints.
      hive.store.writeRunInput(runA.runId, 'ISOLATION_A_BARRIER\r')
      hive.store.writeRunInput(runB.runId, 'ISOLATION_B_BARRIER\r')
      await waitFor(() => {
        const rawA = readFileSync(receivedA, 'utf8')
        const rawB = readFileSync(receivedB, 'utf8')
        expect(rawA).toContain('ISOLATION_A_BARRIER')
        expect(rawB).toContain('ISOLATION_B_BARRIER')
        const deliveredA = expandInboxReferences(rawA)
        const deliveredB = expandInboxReferences(rawB)
        expect(deliveredA).toContain('实现登录')
        expect(deliveredB).toContain(ownTaskB)
        expect(deliveredA).not.toContain(ownTaskB)
        expect(deliveredB).not.toContain('实现登录')
      })
    } finally {
      await hive.close()
      if (originalDataDir === undefined) delete process.env.HIVE_DATA_DIR
      else process.env.HIVE_DATA_DIR = originalDataDir
    }
  }, 15_000)
})
