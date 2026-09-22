import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalEnv = { ...process.env }
const fakeCodexPasteAckDelayMs = 3000

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

const countSubmitted = (output: string | undefined) => output?.match(/SUBMITTED:/g)?.length ?? 0
const readCounter = (filePath: string) =>
  existsSync(filePath) ? Number(readFileSync(filePath, 'utf8')) : 0
const outputFromMarker = (output: string | undefined, marker: string) => {
  const index = output?.indexOf(marker) ?? -1
  return index >= 0 ? output?.slice(index) : ''
}

const writeFakeCodexCli = (binDir: string, input: { exitOnPasteNumber?: number } = {}) => {
  const scriptPath = join(binDir, 'codex-node.js')
  writeFileSync(
    scriptPath,
    [
      "process.stdin.setEncoding('utf8')",
      'if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true)',
      `const ACK_DELAY_MS = ${fakeCodexPasteAckDelayMs}`,
      "const ACK_MIN_CHARS = Number(process.env.HIVE_FAKE_CODEX_ACK_MIN_CHARS || '0')",
      "const ACK_FIRST_ONLY = process.env.HIVE_FAKE_CODEX_ACK_FIRST_ONLY === '1'",
      "const ACK_FILE = process.env.HIVE_FAKE_CODEX_ACK_FILE || ''",
      "const PASTE_FILE = process.env.HIVE_FAKE_CODEX_PASTE_FILE || ''",
      'const SUBMIT_READY_DELAY_MS = 150',
      `const EXIT_ON_PASTE_NUMBER = ${input.exitOnPasteNumber ?? 0}`,
      "const PASTE_END = '\\u001b[201~'",
      "const PASTE_START = '\\u001b[200~'",
      "const WINDOWS_CONPTY_STRIPS_PASTE_BOUNDARIES = process.platform === 'win32'",
      'let pasteCount = 0',
      'let submitReadyAt = 0',
      'let submissions = 0',
      "let inputBuffer = ''",
      "process.stdout.write('› ')",
      'const handlePaste = (pastedChars) => {',
      '  pasteCount += 1',
      "  if (PASTE_FILE) require('node:fs').writeFileSync(PASTE_FILE, String(pasteCount))",
      '  if (pasteCount === EXIT_ON_PASTE_NUMBER) {',
      '    setTimeout(() => process.exit(0), 100)',
      '    return',
      '  }',
      '  if (pastedChars < ACK_MIN_CHARS || (ACK_FIRST_ONLY && pasteCount > 1)) {',
      '    submitReadyAt = Date.now() + SUBMIT_READY_DELAY_MS',
      '    return',
      '  }',
      '  const acknowledgedPasteNumber = pasteCount',
      '  setTimeout(() => {',
      "    process.stdout.write('\\n[Pasted Content ' + pastedChars + ' chars]\\n')",
      "    if (ACK_FILE) require('node:fs').writeFileSync(ACK_FILE, String(acknowledgedPasteNumber))",
      '    submitReadyAt = Date.now() + SUBMIT_READY_DELAY_MS',
      '  }, ACK_DELAY_MS)',
      '}',
      "process.stdin.on('data', (chunk) => {",
      "  const isEnter = chunk === '\\r' || chunk === '\\n' || chunk === '\\r\\n'",
      '  if (isEnter) {',
      '    if (submitReadyAt > 0 && Date.now() >= submitReadyAt) {',
      '      submissions += 1',
      "      process.stdout.write('\\nSUBMITTED:' + submissions + '\\n› ')",
      '    } else {',
      "      process.stdout.write('\\nEARLY_ENTER_IGNORED\\n› ')",
      '    }',
      '    return',
      '  }',
      '  inputBuffer += chunk',
      '  while (inputBuffer.length) {',
      '    const terminators = WINDOWS_CONPTY_STRIPS_PASTE_BOUNDARIES && !inputBuffer.includes(PASTE_START)',
      "      ? [PASTE_END, '</hive-message>', '</hive-system-message>'] : [PASTE_END]",
      '    const boundary = terminators.map(marker => ({ marker, index: inputBuffer.indexOf(marker) }))',
      '      .filter(item => item.index >= 0).sort((a, b) => a.index - b.index)[0]',
      '    if (!boundary) break',
      '    const end = boundary.index + boundary.marker.length',
      '    const message = inputBuffer.slice(0, end)',
      '    inputBuffer = inputBuffer.slice(end)',
      '    if (boundary.marker === PASTE_END && !message.slice(0, -PASTE_END.length).trim()) continue',
      "    process.stdout.write('CODEX_IN:' + message)",
      '    handlePaste(message.length)',
      '  }',
      '})',
      'process.stdin.resume()',
    ].join('\n')
  )

  const unixCli = join(binDir, 'codex')
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)

  const winCli = join(binDir, 'codex.cmd')
  writeFileSync(winCli, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`)
}

afterEach(() => {
  process.env = { ...originalEnv }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('team send Codex pasted-content submit regression', () => {
  test('team send through the CLI waits for Codex pasted-content acknowledgement before submit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-cli-codex-paste-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    tempDirs.push(dataDir)
    const ackFile = join(dataDir, 'codex-ack-count.txt')
    const pasteFile = join(dataDir, 'codex-paste-count.txt')
    writeFakeCodexCli(binDir)

    const orchScript = join(workspacePath, 'orch-passive.js')
    writeFileSync(orchScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

    process.env = {
      ...originalEnv,
      HIVE_DATA_DIR: dataDir,
      HIVE_FAKE_CODEX_ACK_FILE: ackFile,
      HIVE_FAKE_CODEX_PASTE_FILE: pasteFile,
      PATH: `${binDir}${delimiter}${originalEnv.PATH ?? ''}`,
    }
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'CodexAck',
          path: workspacePath,
        }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      const configure = async (agentId: string, body: Record<string, unknown>) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify(body),
          }
        )
        expect(response.status).toBe(204)
      }
      const startAgent = async (agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({ hive_port: String(hive.port) }),
          }
        )
        expect(response.status).toBe(201)
      }

      await configure(orchestratorId, { command: process.execPath, args: [orchScript] })
      await configure(worker.id, { command: 'codex', args: [] })
      await startAgent(orchestratorId)
      await startAgent(worker.id)

      const orchToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      process.env = {
        ...process.env,
        HIVE_AGENT_ID: orchestratorId,
        HIVE_AGENT_TOKEN: orchToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }

      let submittedBeforeSend = 0
      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        submittedBeforeSend = countSubmitted(run?.output)
        expect(run).toBeDefined()
        expect(submittedBeforeSend).toBeGreaterThanOrEqual(1)
        expect(readCounter(pasteFile)).toBeGreaterThanOrEqual(1)
      }, 7000)
      const pasteBeforeSend = readCounter(pasteFile)

      const marker = 'CODEX_MEDIUM_DISPATCH_MARKER'
      const mediumTask = `${marker}: ${'逐项检查 Windows Codex 粘贴提交。'.repeat(12)}`
      await runTeamCommand(['send', 'Alice', mediumTask])

      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        const dispatchOutput = outputFromMarker(run?.output, marker)
        expect(dispatchOutput).toContain('[Pasted Content ')
        expect(countSubmitted(dispatchOutput)).toBe(1)
        expect(countSubmitted(run?.output)).toBeGreaterThanOrEqual(submittedBeforeSend + 1)
        expect(readCounter(pasteFile)).toBeGreaterThanOrEqual(pasteBeforeSend + 1)
      }, 7000)
    } finally {
      await hive.close()
    }
  }, 25000)

  test('team report to a Codex orchestrator submits short payloads without waiting for pasted-content ack timeout', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-cli-codex-report-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    tempDirs.push(dataDir)
    const ackFile = join(dataDir, 'codex-ack-count.txt')
    const pasteFile = join(dataDir, 'codex-paste-count.txt')
    writeFakeCodexCli(binDir)

    const workerScript = join(workspacePath, 'worker-passive.js')
    writeFileSync(workerScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

    process.env = {
      ...originalEnv,
      HIVE_DATA_DIR: dataDir,
      HIVE_FAKE_CODEX_ACK_FILE: ackFile,
      HIVE_FAKE_CODEX_PASTE_FILE: pasteFile,
      // Simulate real Codex behavior for short report pastes: startup still
      // gets the collapsed-paste ack, but the report is rendered literally in
      // the input box and never emits "[Pasted Content]".
      HIVE_FAKE_CODEX_ACK_FIRST_ONLY: '1',
      PATH: `${binDir}${delimiter}${originalEnv.PATH ?? ''}`,
    }
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'CodexReport',
          path: workspacePath,
        }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      const configure = async (agentId: string, body: Record<string, unknown>) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify(body),
          }
        )
        expect(response.status).toBe(204)
      }
      const startAgent = async (agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({ hive_port: String(hive.port) }),
          }
        )
        expect(response.status).toBe(201)
      }

      await configure(orchestratorId, { command: 'codex', args: [] })
      await configure(worker.id, { command: process.execPath, args: [workerScript] })
      await startAgent(orchestratorId)
      await startAgent(worker.id)

      const orchToken = hive.store.peekAgentToken(orchestratorId)
      const workerToken = hive.store.peekAgentToken(worker.id)
      if (!orchToken) throw new Error('Expected orchestrator token after start')
      if (!workerToken) throw new Error('Expected worker token after start')

      let submittedBeforeReport = 0
      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, orchestratorId)
        submittedBeforeReport = countSubmitted(run?.output)
        expect(submittedBeforeReport).toBeGreaterThanOrEqual(1)
        expect(readCounter(ackFile)).toBeGreaterThanOrEqual(1)
        expect(run?.output).not.toContain('EARLY_ENTER_IGNORED')
      }, 7000)

      process.env = {
        ...process.env,
        HIVE_AGENT_ID: orchestratorId,
        HIVE_AGENT_TOKEN: orchToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }
      await runTeamCommand(['send', 'Alice', 'Report back with the short marker.'])

      const marker = 'CODEX_SHORT_REPORT_MARKER'
      process.env = {
        ...process.env,
        HIVE_AGENT_ID: worker.id,
        HIVE_AGENT_TOKEN: workerToken,
      }
      await runTeamCommand(['report', marker])

      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, orchestratorId)
        const reportOutput = outputFromMarker(run?.output, marker)
        expect(reportOutput).toContain(marker)
        expect(countSubmitted(run?.output)).toBeGreaterThanOrEqual(submittedBeforeReport + 1)
        expect(run?.output).not.toContain('EARLY_ENTER_IGNORED')
      }, 2500)
    } finally {
      await hive.close()
    }
  }, 25000)

  test('team send cancels an accepted dispatch if Codex exits before submit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-cli-codex-exit-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    tempDirs.push(dataDir)
    const pasteFile = join(dataDir, 'codex-paste-count.txt')
    writeFakeCodexCli(binDir, { exitOnPasteNumber: 2 })

    const orchScript = join(workspacePath, 'orch-passive.js')
    writeFileSync(orchScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

    process.env = {
      ...originalEnv,
      HIVE_DATA_DIR: dataDir,
      HIVE_FAKE_CODEX_PASTE_FILE: pasteFile,
      PATH: `${binDir}${delimiter}${originalEnv.PATH ?? ''}`,
    }
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'CodexExit',
          path: workspacePath,
        }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      const configure = async (agentId: string, body: Record<string, unknown>) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify(body),
          }
        )
        expect(response.status).toBe(204)
      }
      const startAgent = async (agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({ hive_port: String(hive.port) }),
          }
        )
        expect(response.status).toBe(201)
      }

      await configure(orchestratorId, { command: process.execPath, args: [orchScript] })
      await configure(worker.id, { command: 'codex', args: [] })
      await startAgent(orchestratorId)
      await startAgent(worker.id)

      const orchToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      process.env = {
        ...process.env,
        HIVE_AGENT_ID: orchestratorId,
        HIVE_AGENT_TOKEN: orchToken,
        HIVE_PORT: String(hive.port),
        HIVE_PROJECT_ID: workspace.id,
      }

      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(run).toBeDefined()
        expect(countSubmitted(run?.output)).toBe(1)
        expect(readCounter(pasteFile)).toBeGreaterThanOrEqual(1)
      }, 7000)

      const marker = 'CODEX_EXIT_DURABLE_DISPATCH_MARKER'
      const longTask = `${marker}: ${'保持 accepted dispatch，不因 PTY 退出回滚。'.repeat(220)}`
      await runTeamCommand(['send', 'Alice', longTask])

      await waitFor(() => {
        expect(hive.store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()
      }, 7000)
      await waitFor(() => {
        const dispatch = hive.store
          .listDispatches(workspace.id)
          .find((item) => item.text === longTask)
        expect(dispatch).toMatchObject({
          status: 'cancelled',
          text: longTask,
          toAgentId: worker.id,
        })
        expect(dispatch?.submittedAt).toEqual(expect.any(Number))
        expect(hive.store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(0)
      }, 12000)
    } finally {
      await hive.close()
    }
  }, 25000)
})
