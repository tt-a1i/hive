import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 3000,
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

const expectReceivedText = (received: string, text: string) => {
  expect(received).toContain(text)
}

afterEach(() => {
  delete process.env.HIVE_DATA_DIR
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('agent startup instructions', () => {
  test('new orchestrator and worker runs receive team command guidance over real PTY stdin', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-agent-startup-instructions-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    tempDirs.push(dataDir)

    const fakeClaude = join(binDir, 'claude')
    writeFileSync(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "const { appendFileSync } = require('node:fs')",
        `const receiptPath = ${JSON.stringify(dataDir)} + '/' + encodeURIComponent(process.env.HIVE_AGENT_ID) + '.stdin.txt'`,
        "process.stdin.setEncoding('utf8')",
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        "const PASTE_OPEN = '\\u001b[200~'",
        "const PASTE_END = '\\u001b[201~'",
        'let pasteSeen = false',
        'let acknowledged = false',
        'let submitReadyAt = 0',
        'const acknowledgePaste = () => {',
        '  if (acknowledged) return',
        '  acknowledged = true',
        "  process.stdout.write('\\n[Pasted text #1 +1 lines]\\n')",
        '  submitReadyAt = Date.now() + 500',
        '}',
        "process.stdout.write('❯ ')",
        "process.stdin.on('data', (chunk) => {",
        '  appendFileSync(receiptPath, chunk)',
        "  process.stdout.write('IN:' + chunk)",
        "  if (chunk.includes(PASTE_OPEN) || chunk.includes('<hive-message') || chunk.includes('<hive-system-message')) pasteSeen = true",
        '  if (chunk.includes(PASTE_END)) acknowledgePaste()',
        '  else if (process.platform === "win32" && pasteSeen && (chunk.includes("</hive-message>") || chunk.includes("</hive-system-message>"))) acknowledgePaste()',
        '  const isSubmit = submitReadyAt > 0 && /^[\\r\\n]+$/.test(chunk)',
        "  if (isSubmit && Date.now() >= submitReadyAt) process.stdout.write('\\nSUBMITTED\\n❯ ')",
        "  else if (isSubmit) process.stdout.write('\\nEARLY_ENTER_IGNORED\\n❯ ')",
        '  if (isSubmit) {',
        '    pasteSeen = false',
        '    acknowledged = false',
        '    submitReadyAt = 0',
        '  }',
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )
    chmodSync(fakeClaude, 0o755)
    if (process.platform === 'win32') {
      writeFileSync(
        `${fakeClaude}.cmd`,
        `@echo off\r\n"${process.execPath}" "%~dp0${basename(fakeClaude)}" %*\r\n`
      )
    }

    process.env.HIVE_DATA_DIR = dataDir
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
    const hive = await runHiveCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart: false, name: 'Alice', role: 'coder' }),
      })
      expect(workerResponse.status).toBe(201)
      const worker = (await workerResponse.json()) as { id: string }
      const configure = async (agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({
              command: 'claude',
              args: [],
            }),
          }
        )
        expect(response.status).toBe(204)
      }
      const start = async (agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({ hive_port: String(hive.port) }),
          }
        )
        expect(response.status).toBe(201)
        const payload = (await response.json()) as { run_id: string }
        return { runId: payload.run_id }
      }

      await configure(orchestratorId)
      await configure(worker.id)
      const orchestratorRun = await start(orchestratorId)
      const workerRun = await start(worker.id)

      // HTTP start returns before startup guidance is submitted. Synchronize on
      // actual delivery before checking child receipts; retain the overall test
      // deadline and the independent SUBMITTED assertion below.
      for (const agentId of [orchestratorId, worker.id]) {
        const live = hive.store.getActiveRunByAgentId(workspace.id, agentId)
        if (!live) throw new Error('Started agent has no live run')
        await live.postStartInputReady
        expect(live.startupReadyAt).toBeTypeOf('number')
      }

      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runtime/runs/${orchestratorRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await response.json()) as { output: string }
        const output = readFileSync(
          join(dataDir, `${encodeURIComponent(orchestratorId)}.stdin.txt`),
          'utf8'
        )
        expect(output).toContain('<hive-message kind="startup">')
        expect(output).toContain('You are Orchestrator (orchestrator) in workspace Alpha.')
        expect(output).toContain('team send "<member-name>" "<task>"')
        expect(output).toContain('team list')
        expect(output).toContain('Hive boundaries:')
        expect(output).toContain(
          'Do not create members unless the user explicitly authorized new resources'
        )
        expect(output).toContain('team guide dispatch')
        expect(output).toContain('team guide tasks')
        expect(output).toContain('team guide member')
        expect(output).not.toContain('Command usage:')
        expect(output).toContain('member')
        expect(output).not.toContain('If exactly one worker is available')
        expect(output).not.toContain('closed exception')
        expect(output).not.toContain('Hive never pushes membership changes')
        // The orchestrator startup must not advertise `team report` as a
        // command the orchestrator itself runs (it's the worker's syntax).
        // After the --ephemeral rule was added, the body explains worker
        // lifecycle by saying "worker 收到第一次 team report 后自动消亡" — so
        // the substring legitimately appears, but never with a quoted
        // command marker indicating the orchestrator should call it.
        expect(output).not.toContain('"team report')
        expect(output).not.toMatch(/team report\s+"</)
        expect(body.output).toContain('SUBMITTED')
      }, 6000)

      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runtime/runs/${workerRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await response.json()) as { output: string }
        const output = readFileSync(
          join(dataDir, `${encodeURIComponent(worker.id)}.stdin.txt`),
          'utf8'
        )
        expect(output).toContain('<hive-message kind="startup">')
        expect(output).toContain('You are Alice (coder) in workspace Alpha.')
        expectReceivedText(output, 'team report --dispatch <id> --seen <required_seen_seq> --stdin')
        expectReceivedText(output, 'team ask "<question>"')
        expectReceivedText(
          output,
          'Stay quiet for routine readiness or standby. Use `team status` only when explicitly requested or when a non-task status needs attention; it wakes the Orchestrator and never closes a dispatch.'
        )
        expect(output).not.toContain('Startup handshake:')
        expect(output).not.toContain('Run once:')
        expect(output).not.toContain('records readiness, not task completion')
        expectReceivedText(
          output,
          'If no dispatch has been assigned in this conversation, end this turn quietly and wait for a later task message.'
        )
        // Members are not authorized for `team list` (403) — the startup
        // command list must not advertise it.
        expect(output).not.toContain('- team list')
        expect(output).not.toContain('--success')
        expect(output).not.toContain('--failed')
        expect(output).not.toContain('team send <member-name>')
        expect(body.output).toContain('SUBMITTED')
      }, 6000)
    } finally {
      await hive.close()
    }
  }, 20_000)
})
