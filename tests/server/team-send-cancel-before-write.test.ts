import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { inboxReaderCommonJsSource } from '../helpers/inbox.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH

const writeSlowAckClaude = (binDir: string) => {
  mkdirSync(binDir, { recursive: true })
  const scriptPath = join(binDir, 'slow-claude.js')
  writeFileSync(
    scriptPath,
    [
      inboxReaderCommonJsSource,
      "process.stdin.setEncoding('utf8')",
      'if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true)',
      "const PASTE_END = '\\u001b[201~'",
      "let buffer = ''",
      'let pasteCount = 0',
      "process.stdout.write('❯ ')",
      "process.stdin.on('data', (chunk) => {",
      '  buffer += chunk',
      '  buffer = expandReceivedInbox(buffer)',
      '  if (buffer.includes(PASTE_END) || (process.platform === "win32" && buffer.includes("</hive-message>"))) {',
      '    pasteCount += 1',
      '    const current = pasteCount',
      '    const dispatch = buffer.match(/dispatch_id: ([^\\r\\n]+)/)',
      "    if (dispatch) process.stdout.write('\\nDISPATCH:' + dispatch[1])",
      '    setTimeout(() => {',
      "      process.stdout.write('\\n[Pasted text #' + current + ']\\n❯ ')",
      '    }, 800)',
      "    buffer = ''",
      '    return',
      '  }',
      '  if (/^[\\r\\n]+$/.test(chunk)) {',
      "    process.stdout.write('\\nSUBMITTED\\n❯ ')",
      "    buffer = ''",
      '  }',
      '})',
      'process.stdin.resume()',
      'setInterval(() => {}, 1 << 30)',
    ].join('\n')
  )
  const unixCli = join(binDir, 'claude')
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)
  writeFileSync(
    join(binDir, 'claude.cmd'),
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
  )
}

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  throw lastError
}

afterEach(async () => {
  delete process.env.HIVE_DATA_DIR
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('send paste skipped after cancel (#64)', () => {
  test('a queued writeSendPrompt does not paste a dispatch that was cancelled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-send-cancel-before-write-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    writeSlowAckClaude(join(dataDir, 'bin'))
    process.env.PATH = `${join(dataDir, 'bin')}${delimiter}${originalPath ?? ''}`
    process.env.HIVE_DATA_DIR = dataDir

    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`
      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      for (const agentId of [orchestratorId, worker.id]) {
        await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ command: 'claude' }),
        })
      }
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })
      const orchToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token after start')

      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(run?.status === 'starting' || run?.status === 'running').toBe(true)
      })
      // Let post-start startup paste finish so the next two sends share the stdin chain.
      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(run?.output).toMatch(/\[Pasted text #1\]/)
      }, 6000)

      const firstText = 'FIRST_TASK_OCCUPIES_THE_CHAIN'
      const cancelledText = 'THIS_MUST_NOT_BE_PASTED_AFTER_CANCEL'
      const send = async (text: string) => {
        const response = await fetch(`${baseUrl}/api/team/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project_id: workspace.id,
            from_agent_id: orchestratorId,
            token: orchToken,
            to: 'Alice',
            text,
          }),
        })
        expect(response.status).toBe(202)
        return (await response.json()) as { dispatch_id: string }
      }

      const first = await send(firstText)
      const second = await send(cancelledText)
      const cancelResponse = await fetch(`${baseUrl}/api/team/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: orchToken,
          dispatch_id: second.dispatch_id,
          reason: 'superseded',
        }),
      })
      expect(cancelResponse.status).toBe(202)

      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(run?.output).toContain(`DISPATCH:${first.dispatch_id}`)
      })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const output = hive.store.getActiveRunByAgentId(workspace.id, worker.id)?.output ?? ''
      expect(output).not.toContain(`DISPATCH:${second.dispatch_id}`)
      expect(output).not.toContain(cancelledText)
      expect(
        hive.store.listDispatches(workspace.id).find((row) => row.id === second.dispatch_id)
      ).toMatchObject({ status: 'cancelled' })
    } finally {
      await hive.close()
    }
  }, 30_000)
})
