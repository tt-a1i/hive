import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import Database from '../../src/server/sqlite.js'
import {
  serializeWorkspaceMemoryEnabled,
  workspaceMemoryEnabledKey,
} from '../../src/server/team-memory-feature.js'
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

const ESCAPE = String.fromCharCode(27)
const BELL = String.fromCharCode(7)
const TERMINAL_CONTROL_PATTERN = new RegExp(
  `${ESCAPE}\\[[0-?]*[ -/]*[@-~]|${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`,
  'gu'
)

const compactTerminalText = (text: string) =>
  text
    .replace(TERMINAL_CONTROL_PATTERN, '')
    .replace(/\s+/gu, '')
    .replace(/(.)\1+/gsu, '$1')

const expectOutputToContainTerminalText = (output: string, text: string) => {
  expect(compactTerminalText(output)).toContain(compactTerminalText(text))
}

const listMemoryInjections = (dataDir: string) => {
  const db = new Database(join(dataDir, 'runtime.sqlite'), { readOnly: true })
  const rows = db
    .prepare(
      `SELECT context_type, memory_id, target_agent_id_snapshot, workspace_id
       FROM memory_injections
       ORDER BY injected_at ASC, id ASC`
    )
    .all() as Array<{
    context_type: string
    memory_id: string
    target_agent_id_snapshot: string
    workspace_id: string
  }>
  db.close()
  return rows
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
      const pinnedMemory = hive.store.addMemoryEntry({
        actor: { id: orchestratorId, name: 'Orchestrator', role: 'orchestrator' },
        body: 'Pinned startup memory must be present for every fresh agent.',
        kind: 'decision',
        tags: ['startup'],
        workspaceId: workspace.id,
      })
      const digestMemory = hive.store.addMemoryEntry({
        actor: { id: orchestratorId, name: 'Orchestrator', role: 'orchestrator' },
        body: 'Digest startup memory should be bounded but reusable.',
        kind: 'pitfall',
        tags: ['digest'],
        workspaceId: workspace.id,
      })
      const db = new Database(join(dataDir, 'runtime.sqlite'))
      db.prepare('UPDATE memory_entries SET pinned = 1 WHERE id = ?').run(pinnedMemory.id)
      db.close()

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

      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runtime/runs/${orchestratorRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await response.json()) as { output: string }
        const output = body.output.replaceAll('IN:', '')
        expect(output).toContain('<hive-message kind="startup">')
        expect(output).toContain('<hive-memory context="startup">')
        expectOutputToContainTerminalText(output, 'Pinned startup memory')
        expectOutputToContainTerminalText(output, 'present for every fresh agent')
        expectOutputToContainTerminalText(output, 'Digest startup memory')
        expectOutputToContainTerminalText(output, 'reusable')
        expect(output).toContain('You are Orchestrator (orchestrator) in workspace Alpha.')
        expect(output).toContain('team send "<member-name>" "<task>"')
        expect(output).toContain('team list')
        expect(output).toContain('Hive boundaries:')
        expect(output).toContain(
          'Do not create members unless the user explicitly authorized new resources'
        )
        expect(output).toContain('team guide dispatch')
        expect(output).toContain('team guide tasks')
        expect(output).toContain('team guide memory')
        expect(output).toContain('team guide member')
        expect(output).not.toContain('Memory Dream:')
        expect(output).not.toContain('Command usage:')
        expect(output).not.toContain('Treat recalled memory as background evidence')
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
        expect(output).toContain('SUBMITTED')
      }, 6000)

      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runtime/runs/${workerRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await response.json()) as { output: string }
        const output = body.output.replaceAll('IN:', '')
        expect(output).toContain('<hive-message kind="startup">')
        expect(output).toContain('<hive-memory context="startup">')
        expectOutputToContainTerminalText(output, 'Pinned startup memory')
        expectOutputToContainTerminalText(output, 'present for every fresh agent')
        expectOutputToContainTerminalText(output, 'Digest startup memory')
        expectOutputToContainTerminalText(output, 'reusable')
        expect(output).toContain('You are Alice (coder) in workspace Alpha.')
        expectOutputToContainTerminalText(output, 'Report once when ending responsibility')
        expectOutputToContainTerminalText(output, 'Stay quiet for routine readiness or standby.')
        expect(compactTerminalText(output)).not.toContain(compactTerminalText('Startup handshake:'))
        expect(compactTerminalText(output)).not.toContain(compactTerminalText('Run once:'))
        expect(compactTerminalText(output)).not.toContain(
          compactTerminalText('records readiness, not task completion')
        )
        expectOutputToContainTerminalText(
          output,
          'If no dispatch has been assigned in this conversation, end this turn quietly'
        )
        // Members are not authorized for `team list` (403) — the startup
        // command list must not advertise it.
        expect(output).not.toContain('- team list')
        expect(output).toContain('--success')
        expect(output).toContain('--failed')
        expect(output).not.toContain('team send <member-name>')
        expect(output).toContain('SUBMITTED')
      }, 6000)

      await waitFor(() => {
        expect(listMemoryInjections(dataDir)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              context_type: 'startup',
              memory_id: pinnedMemory.id,
              target_agent_id_snapshot: orchestratorId,
              workspace_id: workspace.id,
            }),
            expect.objectContaining({
              context_type: 'startup',
              memory_id: digestMemory.id,
              target_agent_id_snapshot: orchestratorId,
              workspace_id: workspace.id,
            }),
            expect.objectContaining({
              context_type: 'startup',
              memory_id: pinnedMemory.id,
              target_agent_id_snapshot: worker.id,
              workspace_id: workspace.id,
            }),
            expect.objectContaining({
              context_type: 'startup',
              memory_id: digestMemory.id,
              target_agent_id_snapshot: worker.id,
              workspace_id: workspace.id,
            }),
          ])
        )
      })
    } finally {
      await hive.close()
    }
  }, 20_000)

  test('workspace memory off skips startup digest and injection audit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-agent-startup-memory-off-'))
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
        "process.stdin.setEncoding('utf8')",
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        "  if (chunk.includes('</hive-message>')) process.stdout.write('\\nSUBMITTED\\n')",
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
          name: 'MemoryOff',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`
      hive.store.addMemoryEntry({
        actor: { id: orchestratorId, name: 'Orchestrator', role: 'orchestrator' },
        body: 'This startup memory must stay out while disabled.',
        kind: 'fact',
        workspaceId: workspace.id,
      })
      hive.store.settings.setAppState(
        workspaceMemoryEnabledKey(workspace.id),
        serializeWorkspaceMemoryEnabled(false)
      )

      const configureResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ command: 'claude', args: [] }),
        }
      )
      expect(configureResponse.status).toBe(204)
      const startResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ hive_port: String(hive.port) }),
        }
      )
      expect(startResponse.status).toBe(201)
      const run = (await startResponse.json()) as { run_id: string }

      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runtime/runs/${run.run_id}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await response.json()) as { output: string }
        const output = body.output.replaceAll('IN:', '')
        expect(output).toContain('<hive-message kind="startup">')
        expect(output).not.toContain('<hive-memory context="startup">')
        expect(output).not.toContain('This startup memory must stay out while disabled.')
      }, 6000)
      expect(listMemoryInjections(dataDir)).toEqual([])
    } finally {
      await hive.close()
    }
  }, 20_000)
})
