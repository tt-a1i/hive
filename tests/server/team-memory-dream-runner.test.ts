import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'
import { serializeDreamRun } from '../../src/server/team-memory-dream-http-serializers.js'
import {
  DREAM_SCHEDULER_FLOOR_MS,
  DREAM_SCHEDULER_IDLE_DEBOUNCE_MS,
} from '../../src/server/team-memory-dream-scheduler.js'
import {
  DREAM_RUNNING_STALE_MS,
  DREAM_STALE_ERROR,
  DreamWorkspaceMissingError,
} from '../../src/server/team-memory-dream-store.js'
import { getMemoryFilePath } from '../../src/server/team-memory-export.js'
import {
  serializeWorkspaceMemoryDreamEnabled,
  serializeWorkspaceMemoryEnabled,
  workspaceMemoryDreamEnabledKey,
  workspaceMemoryEnabledKey,
} from '../../src/server/team-memory-feature.js'
import type { MemoryEntryWithSources } from '../../src/server/team-memory-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let server: Awaited<ReturnType<typeof startTestServer>> | undefined
let cookie = ''
let oldPath: string | undefined
let oldOutputFile: string | undefined
let oldInputFile: string | undefined
let oldCommandFile: string | undefined
let oldEnvFile: string | undefined
let oldDelayMs: string | undefined
let oldTerm: string | undefined
let oldColorTerm: string | undefined
let oldDreamArgs: string | undefined
let oldDreamCommand: string | undefined
let outputFile = ''
let inputFile = ''
let commandFile = ''
let envFile = ''
const tempDirs: string[] = []

const installDreamStub = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-dream-stub-'))
  tempDirs.push(dir)
  outputFile = join(dir, 'dream-output.json')
  inputFile = join(dir, 'dream-input.txt')
  commandFile = join(dir, 'dream-command.txt')
  envFile = join(dir, 'dream-env.txt')
  const writeStub = (name: string) => {
    const body = [
      "const { readFileSync, writeFileSync } = require('node:fs')",
      "let input = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => { input += chunk })",
      "process.stdin.on('end', () => {",
      '  if (process.env.DREAM_STUB_INPUT_FILE) writeFileSync(process.env.DREAM_STUB_INPUT_FILE, input)',
      `  if (process.env.DREAM_STUB_COMMAND_FILE) writeFileSync(process.env.DREAM_STUB_COMMAND_FILE, [${JSON.stringify(name)}, ...process.argv.slice(2)].join(' '))`,
      "  if (process.env.DREAM_STUB_ENV_FILE) writeFileSync(process.env.DREAM_STUB_ENV_FILE, 'TERM=' + (process.env.TERM || '') + '\\nCOLORTERM=' + (process.env.COLORTERM || '') + '\\n')",
      '  const outputFile = process.env.DREAM_STUB_OUTPUT_FILE',
      '  if (!outputFile) process.exit(2)',
      "  const delay = Number(process.env.DREAM_STUB_DELAY_MS || '0')",
      "  setTimeout(() => process.stdout.write(readFileSync(outputFile, 'utf8')), delay)",
      '})',
    ].join('\n')
    if (process.platform === 'win32') {
      const script = join(dir, `${name}-stub.cjs`)
      writeFileSync(script, body)
      writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`)
      return
    }
    const bin = join(dir, name)
    writeFileSync(bin, `#!/usr/bin/env node\n${body}`)
    chmodSync(bin, 0o755)
  }
  writeStub('claude')
  writeStub('codex')
  process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`
  process.env.DREAM_STUB_OUTPUT_FILE = outputFile
  process.env.DREAM_STUB_INPUT_FILE = inputFile
  process.env.DREAM_STUB_COMMAND_FILE = commandFile
  process.env.DREAM_STUB_ENV_FILE = envFile
  process.env.HIVE_MEMORY_DREAM_ARGS_JSON = '["--print"]'
  process.env.HIVE_MEMORY_DREAM_COMMAND = 'claude'
}

beforeEach(async () => {
  oldPath = process.env.PATH
  oldOutputFile = process.env.DREAM_STUB_OUTPUT_FILE
  oldInputFile = process.env.DREAM_STUB_INPUT_FILE
  oldCommandFile = process.env.DREAM_STUB_COMMAND_FILE
  oldEnvFile = process.env.DREAM_STUB_ENV_FILE
  oldDelayMs = process.env.DREAM_STUB_DELAY_MS
  oldTerm = process.env.TERM
  oldColorTerm = process.env.COLORTERM
  oldDreamArgs = process.env.HIVE_MEMORY_DREAM_ARGS_JSON
  oldDreamCommand = process.env.HIVE_MEMORY_DREAM_COMMAND
  installDreamStub()
  server = await startTestServer()
  cookie = await getUiCookie(server.baseUrl)
})

afterEach(async () => {
  await server?.close()
  server = undefined
  cookie = ''
  process.env.PATH = oldPath
  if (oldOutputFile === undefined) delete process.env.DREAM_STUB_OUTPUT_FILE
  else process.env.DREAM_STUB_OUTPUT_FILE = oldOutputFile
  if (oldInputFile === undefined) delete process.env.DREAM_STUB_INPUT_FILE
  else process.env.DREAM_STUB_INPUT_FILE = oldInputFile
  if (oldCommandFile === undefined) delete process.env.DREAM_STUB_COMMAND_FILE
  else process.env.DREAM_STUB_COMMAND_FILE = oldCommandFile
  if (oldEnvFile === undefined) delete process.env.DREAM_STUB_ENV_FILE
  else process.env.DREAM_STUB_ENV_FILE = oldEnvFile
  if (oldDelayMs === undefined) delete process.env.DREAM_STUB_DELAY_MS
  else process.env.DREAM_STUB_DELAY_MS = oldDelayMs
  if (oldTerm === undefined) delete process.env.TERM
  else process.env.TERM = oldTerm
  if (oldColorTerm === undefined) delete process.env.COLORTERM
  else process.env.COLORTERM = oldColorTerm
  if (oldDreamArgs === undefined) delete process.env.HIVE_MEMORY_DREAM_ARGS_JSON
  else process.env.HIVE_MEMORY_DREAM_ARGS_JSON = oldDreamArgs
  if (oldDreamCommand === undefined) delete process.env.HIVE_MEMORY_DREAM_COMMAND
  else process.env.HIVE_MEMORY_DREAM_COMMAND = oldDreamCommand
  oldPath = undefined
  oldOutputFile = undefined
  oldInputFile = undefined
  oldCommandFile = undefined
  oldEnvFile = undefined
  oldDelayMs = undefined
  oldTerm = undefined
  oldColorTerm = undefined
  oldDreamArgs = undefined
  oldDreamCommand = undefined
  outputFile = ''
  inputFile = ''
  commandFile = ''
  envFile = ''
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const uiFetch = (path: string, init: RequestInit = {}) => {
  if (!server) throw new Error('Expected test server')
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      cookie,
      ...init.headers,
    },
  })
}

const createWorkspace = (input: { configureDreamCli?: boolean } = {}) => {
  if (!server) throw new Error('Expected test server')
  const workspacePath = mkdtempSync(join(tmpdir(), 'hive-memory-dream-'))
  tempDirs.push(workspacePath)
  const workspace = server.store.createWorkspace(workspacePath, 'Dream Workspace')
  if (input.configureDreamCli !== false) {
    server.store.configureAgentLaunch(workspace.id, `${workspace.id}:orchestrator`, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
    })
  }
  return workspace
}

const writeDreamOutput = (value: unknown) => {
  writeFileSync(outputFile, typeof value === 'string' ? value : JSON.stringify(value))
}

const dispatchToReportWorker = async (workspaceId: string, name: string, text: string) => {
  if (!server) throw new Error('Expected test server')
  const runtime = server
  const directory = mkdtempSync(join(tmpdir(), 'hive-dream-report-'))
  tempDirs.push(directory)
  const script = join(directory, 'receiver.cjs')
  writeFileSync(
    script,
    "process.stdin.setRawMode(true); process.stdin.on('data', data => process.stdout.write(data)); console.log('DREAM_REPORT_READY'); process.stdin.resume()\n"
  )
  const worker = runtime.store.addWorker(workspaceId, { name, role: 'tester' })
  runtime.store.configureAgentLaunch(workspaceId, worker.id, {
    command: process.execPath,
    args: [script],
  })
  await runtime.store.startAgent(workspaceId, worker.id, {
    hivePort: new URL(runtime.baseUrl).port,
  })
  await expect
    .poll(() => runtime.store.getActiveRunByAgentId(workspaceId, worker.id)?.output)
    .toContain('DREAM_REPORT_READY')
  const dispatch = await runtime.store.dispatchTask(workspaceId, worker.id, text, {
    autoStartWorker: false,
    fromAgentId: `${workspaceId}:orchestrator`,
  })
  await expect
    .poll(() => runtime.store.getActiveRunByAgentId(workspaceId, worker.id)?.output)
    .toContain(text)
  await expect
    .poll(
      () =>
        runtime.store.listDispatches(workspaceId).find((item) => item.id === dispatch.id)
          ?.deliveredAt
    )
    .toEqual(expect.any(Number))
  return { worker, dispatch }
}

const openRuntimeDb = () => {
  if (!server) throw new Error('Expected test server')
  return new Database(join(server.dataDir, 'runtime.sqlite'))
}

const waitForAssertion = async (assertion: () => void) => {
  let lastError: unknown
  for (let i = 0; i < 80; i += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}

const addActiveMemory = (
  workspaceId: string,
  body: string,
  kind: MemoryEntryWithSources['kind'] = 'fact'
) => {
  if (!server) throw new Error('Expected test server')
  const orchestrator = server.store.getWorkspaceSnapshot(workspaceId).agents[0]
  if (!orchestrator) throw new Error('Expected orchestrator')
  return server.store.addMemoryEntry({
    actor: { id: orchestrator.id, name: orchestrator.name, role: orchestrator.role },
    body,
    kind,
    procedureRef:
      kind === 'procedure_ref'
        ? { id: `test-procedure-${body.length}`, title: body, type: 'procedure' }
        : null,
    workspaceId,
  })
}

const recordUserInputs = (
  workspaceId: string,
  count: number,
  prefix = 'Dream scheduler message'
) => {
  if (!server) throw new Error('Expected test server')
  const orchestrator = server.store.getWorkspaceSnapshot(workspaceId).agents[0]
  if (!orchestrator) throw new Error('Expected orchestrator')
  for (let index = 0; index < count; index += 1) {
    server.store.recordUserInput(workspaceId, orchestrator.id, `${prefix} ${index}`)
  }
}

const tickDreamSchedulerReady = async (
  now = Date.now(),
  input: { autoApply?: boolean; ensureActive?: boolean } = {}
) => {
  if (!server) throw new Error('Expected test server')
  if (input.ensureActive !== false) {
    await Promise.all(
      server.store.listWorkspaces().map((workspace) => ensureOrchestratorRunning(workspace.id))
    )
  }
  await server.store.tickMemoryDreamScheduler(now)
  await server.store.tickMemoryDreamScheduler(now + DREAM_SCHEDULER_IDLE_DEBOUNCE_MS + 1)
  if (input.autoApply !== false) applyRunningDreamsFromOutput()
}

const hivePort = () => {
  if (!server) throw new Error('Expected test server')
  return server.baseUrl.split(':').at(-1) ?? ''
}

const ensureOrchestratorRunning = async (workspaceId: string) => {
  if (!server) throw new Error('Expected test server')
  const orchestratorId = `${workspaceId}:orchestrator`
  if (server.store.getActiveRunByAgentId(workspaceId, orchestratorId)) return
  if (!server.store.peekAgentLaunchConfig(workspaceId, orchestratorId)) {
    server.store.configureAgentLaunch(workspaceId, orchestratorId, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
    })
  }
  await server.store.startAgent(workspaceId, orchestratorId, { hivePort: hivePort() })
}

const readDreamOps = () => {
  const parsed = JSON.parse(readFileSync(outputFile, 'utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected dream output object')
  }
  const ops = (parsed as { ops?: unknown }).ops
  if (!Array.isArray(ops)) throw new Error('Expected dream output ops array')
  return ops
}

const applyDreamFromOutput = (workspaceId: string, runId: string) => {
  if (!server) throw new Error('Expected test server')
  const input = server.store.getMemoryDreamInput(workspaceId, runId)
  writeFileSync(inputFile, input.prompt)
  return server.store.applyMemoryDreamRun(workspaceId, runId, readDreamOps())
}

const getDreamRunAudit = (runId: string) => {
  const db = openRuntimeDb()
  try {
    return db.prepare('SELECT error, report, status FROM dream_runs WHERE id = ?').get(runId) as
      | { error: string | null; report: string | null; status: string }
      | undefined
  } finally {
    db.close()
  }
}

const getDreamRunStartedAt = (runId: string) => {
  const db = openRuntimeDb()
  try {
    const row = db.prepare('SELECT started_at FROM dream_runs WHERE id = ?').get(runId) as
      | { started_at: number }
      | undefined
    if (!row) throw new Error(`Expected dream run ${runId}`)
    return row.started_at
  } finally {
    db.close()
  }
}

const bumpMemoryUpdatedAt = (memoryId: string, updatedAt: number) => {
  const db = openRuntimeDb()
  try {
    db.prepare('UPDATE memory_entries SET updated_at = ? WHERE id = ?').run(updatedAt, memoryId)
  } finally {
    db.close()
  }
}

const applyRunningDreamsFromOutput = () => {
  if (!server) throw new Error('Expected test server')
  for (const workspace of server.store.listWorkspaces()) {
    for (const run of server.store.listMemoryDreamRuns(workspace.id, 50)) {
      if (run.status === 'running') applyDreamFromOutput(workspace.id, run.id)
    }
  }
}

const triggerDream = async (
  workspaceId: string,
  input: { autoApply?: boolean; ensureActive?: boolean } = {}
) => {
  if (input.ensureActive !== false) await ensureOrchestratorRunning(workspaceId)
  const response = await uiFetch(`/api/ui/workspaces/${workspaceId}/memory/dream-runs`, {
    body: JSON.stringify({}),
    method: 'POST',
  })
  const body = (await response.json()) as {
    ok: boolean
    run: {
      error: string | null
      id: string
      input_seq_from: number | null
      input_seq_to: number | null
      report: {
        added: unknown[]
        archived: unknown[]
        merged: unknown[]
        rewritten: unknown[]
      } | null
      status: string
      trigger: string
      workspace_id: string
    }
  }
  if (response.status === 200 && input.autoApply !== false && body.run.status === 'running') {
    body.run = serializeDreamRun(applyDreamFromOutput(workspaceId, body.run.id))
  }
  return {
    body,
    status: response.status,
  }
}

const revertDream = async (workspaceId: string, runId: string) => {
  const response = await uiFetch(
    `/api/ui/workspaces/${workspaceId}/memory/dream-runs/${runId}/revert`,
    {
      body: JSON.stringify({}),
      method: 'POST',
    }
  )
  return {
    body: (await response.json()) as {
      ok?: boolean
      run?: {
        error: string | null
        id: string
        status: string
        workspace_id: string
      }
    },
    status: response.status,
  }
}

const listDreamRuns = async (workspaceId: string, query = '') => {
  const response = await uiFetch(`/api/ui/workspaces/${workspaceId}/memory/dream-runs${query}`)
  return {
    body: (await response.json()) as {
      error?: string
      ok: boolean
      runs: Array<{
        id: string
        report: {
          added: unknown[]
          archived: unknown[]
          merged: unknown[]
          rewritten: unknown[]
        } | null
        status: string
        trigger: string
        workspace_id: string
      }>
    },
    status: response.status,
  }
}

describe('memory dream manual runner', () => {
  test('manual trigger completes an empty ops run through a real PATH stub', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const orchestrator = server.store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    server.store.recordUserInput(workspace.id, orchestrator.id, 'Remember that pnpm is required.')
    writeDreamOutput({ ops: [] })

    const result = await triggerDream(workspace.id)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      ok: true,
      run: expect.objectContaining({
        error: null,
        input_seq_from: expect.any(Number),
        input_seq_to: expect.any(Number),
        report: { added: [], archived: [], merged: [], rewritten: [] },
        status: 'completed',
        trigger: 'manual',
        workspace_id: workspace.id,
      }),
    })
    expect(server.store.listMemoryEntries(workspace.id, { statuses: ['active'] })).toEqual([])
  })

  test('valid ops apply atomically and record a diff plus revert blob', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const rewriteTarget = addActiveMemory(workspace.id, 'Relative date: tomorrow.', 'decision')
    const archiveTarget = addActiveMemory(workspace.id, 'Old setup pitfall.', 'pitfall')
    const mergeInto = addActiveMemory(workspace.id, 'Use pnpm.', 'procedure_ref')
    const mergeFrom = addActiveMemory(workspace.id, 'Do not use npm.', 'procedure_ref')
    writeDreamOutput({
      ops: [
        {
          body: 'Dream extracted remote relay pitfall.',
          confidence: 0.8,
          kind: 'pitfall',
          op: 'add',
          procedure_ref: {
            id: 'remote-relay-check',
            title: 'Remote relay check',
            type: 'workflow',
          },
          tags: ['remote'],
        },
        {
          body: 'Use absolute date 2026-06-08 for the release note.',
          id: rewriteTarget.id,
          op: 'rewrite',
          procedure_ref: { id: 'release-note', title: 'Release note', type: 'doc' },
          tags: ['release'],
        },
        { id: archiveTarget.id, op: 'archive', reason: 'stale' },
        {
          body: 'Use pnpm for scripts; do not use npm.',
          from: [mergeFrom.id],
          into: mergeInto.id,
          op: 'merge',
        },
      ],
    })

    const result = await triggerDream(workspace.id)

    expect(result.status).toBe(200)
    expect(result.body.run).toEqual(
      expect.objectContaining({
        error: null,
        report: {
          added: [expect.objectContaining({ body: 'Dream extracted remote relay pitfall.' })],
          archived: [expect.objectContaining({ id: archiveTarget.id })],
          merged: [expect.objectContaining({ from: [mergeFrom.id], into: mergeInto.id })],
          rewritten: [expect.objectContaining({ id: rewriteTarget.id })],
        },
        status: 'completed',
      })
    )
    expect(server.store.getMemoryEntry(workspace.id, rewriteTarget.id)).toEqual(
      expect.objectContaining({
        body: 'Use absolute date 2026-06-08 for the release note.',
        procedureRef: { id: 'release-note', title: 'Release note', type: 'doc' },
        tags: ['release'],
      })
    )
    expect(server.store.getMemoryEntry(workspace.id, archiveTarget.id)).toEqual(
      expect.objectContaining({ status: 'archived' })
    )
    expect(server.store.getMemoryEntry(workspace.id, mergeInto.id)).toEqual(
      expect.objectContaining({ body: 'Use pnpm for scripts; do not use npm.' })
    )
    expect(server.store.getMemoryEntry(workspace.id, mergeFrom.id)).toEqual(
      expect.objectContaining({ status: 'archived' })
    )
    const dreamEntry = server.store
      .listMemoryEntries(workspace.id, { statuses: ['active'] })
      .find((memory) => memory.body === 'Dream extracted remote relay pitfall.')
    expect(dreamEntry).toEqual(
      expect.objectContaining({
        confidence: 0.8,
        kind: 'pitfall',
        procedureRef: {
          id: 'remote-relay-check',
          title: 'Remote relay check',
          type: 'workflow',
        },
        source: 'dream',
        sources: [expect.objectContaining({ sourceType: 'dream' })],
      })
    )
    const db = openRuntimeDb()
    try {
      const row = db
        .prepare('SELECT revert_blob FROM dream_runs WHERE id = ?')
        .get(result.body.run.id) as { revert_blob: string } | undefined
      const revertBlob = JSON.parse(row?.revert_blob ?? 'null') as {
        added_entry_ids: string[]
        prior_entries: Array<{ entry: { id: string } }>
      }
      expect(revertBlob.added_entry_ids).toEqual([dreamEntry?.id])
      expect(revertBlob.prior_entries.map((entry) => entry.entry.id)).toEqual(
        expect.arrayContaining([rewriteTarget.id, archiveTarget.id, mergeInto.id, mergeFrom.id])
      )
    } finally {
      db.close()
    }
  })

  test('contradictory report supersedes old memory by adding the new fact and archiving the old one', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const outdated = addActiveMemory(
      workspace.id,
      'Remote mobile access proxies direct /api calls through the gateway.',
      'pitfall'
    )
    const { worker, dispatch } = await dispatchToReportWorker(
      workspace.id,
      'Relay Reviewer',
      'Verify the mobile remote access path.'
    )
    server.store.reportTask(workspace.id, worker.id, {
      dispatchId: dispatch.id,
      status: 'success',
      text: 'Remote mobile access no longer proxies direct /api calls; it must use the E2E relay path.',
    })
    const db = openRuntimeDb()
    let reportSequence = 0
    try {
      reportSequence = (
        db
          .prepare(
            "SELECT sequence FROM messages WHERE workspace_id = ? AND type = 'report' ORDER BY sequence DESC LIMIT 1"
          )
          .get(workspace.id) as { sequence: number }
      ).sequence
    } finally {
      db.close()
    }
    writeDreamOutput({
      ops: [
        {
          body: 'Remote mobile access must use the E2E relay path, not direct gateway /api proxying.',
          confidence: 0.85,
          kind: 'pitfall',
          op: 'add',
          sources: [{ sequence: reportSequence }],
          tags: ['remote', 'relay'],
        },
        { id: outdated.id, op: 'archive', reason: `superseded by report #${reportSequence}` },
      ],
    })

    const result = await triggerDream(workspace.id)

    expect(result.status).toBe(200)
    expect(result.body.run.report).toEqual({
      added: [
        expect.objectContaining({
          body: 'Remote mobile access must use the E2E relay path, not direct gateway /api proxying.',
        }),
      ],
      archived: [expect.objectContaining({ id: outdated.id })],
      merged: [],
      rewritten: [],
    })
    expect(server.store.getMemoryEntry(workspace.id, outdated.id)).toEqual(
      expect.objectContaining({ status: 'archived' })
    )
    expect(server.store.listMemoryEntries(workspace.id, { statuses: ['active'] })).toContainEqual(
      expect.objectContaining({
        body: 'Remote mobile access must use the E2E relay path, not direct gateway /api proxying.',
        confidence: 0.85,
        source: 'dream',
      })
    )
    const prompt = readFileSync(inputFile, 'utf8')
    expect(prompt).toContain('newer protocol evidence contradicts')
    expect(prompt).toContain(outdated.id)
    expect(prompt).toContain(
      'Remote mobile access no longer proxies direct /api calls; it must use the E2E relay path.'
    )
  })

  test('revert restores prior dream changes and archives entries added by the run', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const rewriteTarget = addActiveMemory(workspace.id, 'Relative date: tomorrow.', 'decision')
    const archiveTarget = addActiveMemory(workspace.id, 'Old setup pitfall.', 'pitfall')
    const mergeInto = addActiveMemory(workspace.id, 'Use pnpm.', 'procedure_ref')
    const mergeFrom = addActiveMemory(workspace.id, 'Do not use npm.', 'procedure_ref')
    writeDreamOutput({
      ops: [
        {
          body: 'Dream extracted remote relay pitfall.',
          confidence: 0.8,
          kind: 'pitfall',
          op: 'add',
          tags: ['remote'],
        },
        {
          body: 'Use absolute date 2026-06-08 for the release note.',
          id: rewriteTarget.id,
          op: 'rewrite',
          tags: ['release'],
        },
        { id: archiveTarget.id, op: 'archive', reason: 'stale' },
        {
          body: 'Use pnpm for scripts; do not use npm.',
          from: [mergeFrom.id],
          into: mergeInto.id,
          op: 'merge',
        },
      ],
    })
    const completed = await triggerDream(workspace.id)
    const dreamEntry = server.store
      .listMemoryEntries(workspace.id, { statuses: ['active'] })
      .find((memory) => memory.body === 'Dream extracted remote relay pitfall.')
    if (!dreamEntry) throw new Error('Expected dream entry')

    const reverted = await revertDream(workspace.id, completed.body.run.id)

    expect(reverted.status).toBe(200)
    expect(reverted.body.run).toEqual(
      expect.objectContaining({
        error: null,
        id: completed.body.run.id,
        status: 'reverted',
        workspace_id: workspace.id,
      })
    )
    expect(server.store.getMemoryEntry(workspace.id, rewriteTarget.id)).toEqual(
      expect.objectContaining({
        body: 'Relative date: tomorrow.',
        kind: 'decision',
        status: 'active',
        tags: [],
      })
    )
    expect(server.store.getMemoryEntry(workspace.id, archiveTarget.id)).toEqual(
      expect.objectContaining({ status: 'active' })
    )
    expect(server.store.getMemoryEntry(workspace.id, mergeInto.id)).toEqual(
      expect.objectContaining({ body: 'Use pnpm.', status: 'active' })
    )
    expect(server.store.getMemoryEntry(workspace.id, mergeFrom.id)).toEqual(
      expect.objectContaining({ body: 'Do not use npm.', status: 'active' })
    )
    expect(server.store.getMemoryEntry(workspace.id, dreamEntry.id)).toEqual(
      expect.objectContaining({ source: 'dream', status: 'archived' })
    )
    expect(server.store.getMemoryEntry(workspace.id, rewriteTarget.id)?.sources).toEqual([
      expect.objectContaining({ sourceType: 'manual' }),
    ])
  })

  test('revert handles runs that only added new dream entries', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({
      ops: [{ body: 'Added-only dream memory.', confidence: 0.6, kind: 'fact', op: 'add' }],
    })
    const completed = await triggerDream(workspace.id)
    const dreamEntry = server.store
      .listMemoryEntries(workspace.id, { statuses: ['active'] })
      .find((memory) => memory.body === 'Added-only dream memory.')
    if (!dreamEntry) throw new Error('Expected dream entry')

    const reverted = await revertDream(workspace.id, completed.body.run.id)

    expect(reverted.status).toBe(200)
    expect(reverted.body.run).toEqual(expect.objectContaining({ status: 'reverted' }))
    expect(server.store.getMemoryEntry(workspace.id, dreamEntry.id)).toEqual(
      expect.objectContaining({ status: 'archived' })
    )
  })

  test('revert refreshes the generated memory export after archiving dream entries', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({ ops: [{ body: 'Exported dream memory.', kind: 'fact', op: 'add' }] })
    const completed = await triggerDream(workspace.id)
    const workspacePath = server.store.getWorkspaceSnapshot(workspace.id).summary.path

    await waitForAssertion(() => {
      expect(readFileSync(getMemoryFilePath(workspacePath), 'utf8')).toContain(
        'Exported dream memory.'
      )
    })

    const reverted = await revertDream(workspace.id, completed.body.run.id)

    expect(reverted.status).toBe(200)
    await waitForAssertion(() => {
      const content = readFileSync(getMemoryFilePath(workspacePath), 'utf8')
      expect(content).not.toContain('Exported dream memory.')
      expect(content).toContain('No active memory entries.')
      expect(content).toContain('## Dream changelog')
      expect(content).toContain('[reverted, manual')
      expect(content).toContain('1 added, 0 rewritten, 0 archived, 0 merged')
    })
  })

  test('dream run history lists completed and reverted runs for the workspace UI', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({ ops: [{ body: 'History dream memory.', kind: 'fact', op: 'add' }] })
    const completed = await triggerDream(workspace.id)

    const beforeRevert = await listDreamRuns(workspace.id)
    expect(beforeRevert.status).toBe(200)
    expect(beforeRevert.body.runs).toEqual([
      expect.objectContaining({
        id: completed.body.run.id,
        status: 'completed',
        trigger: 'manual',
        workspace_id: workspace.id,
      }),
    ])

    await revertDream(workspace.id, completed.body.run.id)
    const afterRevert = await listDreamRuns(workspace.id)

    expect(afterRevert.body.runs).toEqual([
      expect.objectContaining({
        id: completed.body.run.id,
        report: expect.objectContaining({ added: [expect.any(Object)] }),
        status: 'reverted',
        trigger: 'manual',
        workspace_id: workspace.id,
      }),
    ])
  })

  test('dream run history tolerates damaged report JSON for UI and export audit', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const workspacePath = server.store.getWorkspaceSnapshot(workspace.id).summary.path
    writeDreamOutput({ ops: [{ body: 'Damaged report history memory.', kind: 'fact', op: 'add' }] })
    const completed = await triggerDream(workspace.id)
    const dreamEntry = server.store
      .listMemoryEntries(workspace.id, { statuses: ['active'] })
      .find((memory) => memory.body === 'Damaged report history memory.')
    if (!dreamEntry) throw new Error('Expected dream memory')
    const db = openRuntimeDb()
    try {
      db.prepare('UPDATE dream_runs SET report = ? WHERE id = ?').run(
        '{not-valid-json',
        completed.body.run.id
      )
    } finally {
      db.close()
    }

    const history = await listDreamRuns(workspace.id)
    expect(history.status).toBe(200)
    expect(history.body.runs).toEqual([
      expect.objectContaining({
        id: completed.body.run.id,
        report: null,
        status: 'completed',
      }),
    ])

    server.store.archiveMemoryEntry(workspace.id, dreamEntry.id)
    await waitForAssertion(() => {
      const content = readFileSync(getMemoryFilePath(workspacePath), 'utf8')
      expect(content).toContain('No active memory entries.')
      expect(content).toContain('[completed, manual')
      expect(content).toContain('no report')
    })
  })

  test('dream run history supports limit and returns 404 for missing workspaces', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({ ops: [] })
    await triggerDream(workspace.id)
    await triggerDream(workspace.id)

    const limited = await listDreamRuns(workspace.id, '?limit=1')
    const missing = await listDreamRuns('missing-workspace-id')

    expect(limited.status).toBe(200)
    expect(limited.body.runs).toHaveLength(1)
    expect(missing.status).toBe(404)
    expect(missing.body.error).toContain('Workspace not found')
  })

  test('failed dream run injection refreshes the generated memory export changelog', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const workspacePath = server.store.getWorkspaceSnapshot(workspace.id).summary.path

    const failed = await triggerDream(workspace.id, { autoApply: false, ensureActive: false })

    expect(failed.status).toBe(409)
    expect(failed.body.run).toEqual(expect.objectContaining({ status: 'failed' }))
    await waitForAssertion(() => {
      const content = readFileSync(getMemoryFilePath(workspacePath), 'utf8')
      expect(content).toContain('No active memory entries.')
      expect(content).toContain('## Dream changelog')
      expect(content).toContain('[failed, manual')
      expect(content).toContain('error: No active run for agent')
    })
  })

  test('repeated revert returns 409 without changing restored memories', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const target = addActiveMemory(workspace.id, 'Keep original wording.', 'fact')
    writeDreamOutput({ ops: [{ body: 'Dream rewrite.', id: target.id, op: 'rewrite' }] })
    const completed = await triggerDream(workspace.id)
    expect(server.store.getMemoryEntry(workspace.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Dream rewrite.' })
    )

    const first = await revertDream(workspace.id, completed.body.run.id)
    const second = await revertDream(workspace.id, completed.body.run.id)

    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    expect(server.store.getMemoryEntry(workspace.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Keep original wording.', status: 'active' })
    )
  })

  test('revert rejects dream runs from another workspace without mutating them', async () => {
    if (!server) throw new Error('Expected test server')
    const left = createWorkspace()
    const right = createWorkspace()
    const target = addActiveMemory(right.id, 'Right workspace original.', 'fact')
    writeDreamOutput({
      ops: [{ body: 'Right workspace dream rewrite.', id: target.id, op: 'rewrite' }],
    })
    const completed = await triggerDream(right.id)

    const rejected = await revertDream(left.id, completed.body.run.id)

    expect(rejected.status).toBe(404)
    expect(server.store.getMemoryEntry(right.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Right workspace dream rewrite.', status: 'active' })
    )
  })

  test('scheduled tick runs after idle debounce when a worker report creates new evidence', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const { worker, dispatch } = await dispatchToReportWorker(
      workspace.id,
      'Reporter',
      'Find the mobile relay pitfall.'
    )
    server.store.reportTask(workspace.id, worker.id, {
      dispatchId: dispatch.id,
      status: 'success',
      text: 'Mobile relay pitfall found.',
    })
    writeDreamOutput({ ops: [] })
    const baseNow = Date.now()

    await server.store.tickMemoryDreamScheduler(baseNow)
    expect(existsSync(inputFile)).toBe(false)
    await tickDreamSchedulerReady(baseNow, { ensureActive: false })

    const db = openRuntimeDb()
    try {
      const rows = db
        .prepare(
          'SELECT trigger, status, error FROM dream_runs WHERE workspace_id = ? ORDER BY started_at'
        )
        .all(workspace.id) as Array<{ error: string | null; status: string; trigger: string }>
      expect(rows).toEqual([
        {
          error: null,
          status: 'completed',
          trigger: 'scheduled',
        },
      ])
    } finally {
      db.close()
    }
  })

  test('scheduled tick does not replay a window already consumed by a manual run', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    recordUserInputs(workspace.id, 20)
    writeDreamOutput({ ops: [] })

    await triggerDream(workspace.id)
    await tickDreamSchedulerReady()

    const db = openRuntimeDb()
    try {
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM dream_runs WHERE workspace_id = ? AND trigger = 'scheduled'"
            )
            .get(workspace.id) as { count: number }
        ).count
      ).toBe(0)
    } finally {
      db.close()
    }
  })

  test('scheduled tick enforces the minimum floor between runs', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    recordUserInputs(workspace.id, 1, 'First floor message')
    writeDreamOutput({ ops: [] })
    const baseNow = Date.now()

    await tickDreamSchedulerReady(baseNow)
    recordUserInputs(workspace.id, 1, 'Second floor message')
    await server.store.tickMemoryDreamScheduler(baseNow + DREAM_SCHEDULER_FLOOR_MS - 1)
    await server.store.tickMemoryDreamScheduler(
      baseNow + DREAM_SCHEDULER_FLOOR_MS + DREAM_SCHEDULER_IDLE_DEBOUNCE_MS + 1
    )

    const db = openRuntimeDb()
    try {
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM dream_runs WHERE workspace_id = ? AND trigger = 'scheduled'"
            )
            .get(workspace.id) as { count: number }
        ).count
      ).toBe(2)
    } finally {
      db.close()
    }
  })

  test('scheduled tick completes through the background dream CLI without an orchestrator', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    recordUserInputs(workspace.id, 1, 'Background dream message')
    writeDreamOutput({ ops: [] })
    const baseNow = Date.now()

    const listScheduled = () => {
      const db = openRuntimeDb()
      try {
        return db
          .prepare(
            "SELECT id, status FROM dream_runs WHERE workspace_id = ? AND trigger = 'scheduled' ORDER BY started_at ASC"
          )
          .all(workspace.id) as Array<{ id: string; status: string }>
      } finally {
        db.close()
      }
    }

    await tickDreamSchedulerReady(baseNow, { ensureActive: false })

    expect(listScheduled()).toEqual([expect.objectContaining({ status: 'completed' })])
    expect(readFileSync(inputFile, 'utf8')).toContain('Background dream message 0')
  })

  test('scheduled tick inherits the workspace Codex orchestrator CLI', async () => {
    if (!server) throw new Error('Expected test server')
    delete process.env.HIVE_MEMORY_DREAM_ARGS_JSON
    delete process.env.HIVE_MEMORY_DREAM_COMMAND
    const workspace = createWorkspace()
    server.store.configureAgentLaunch(workspace.id, `${workspace.id}:orchestrator`, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
      interactiveCommand: 'codex',
      presetAugmentationDisabled: true,
    })
    recordUserInputs(workspace.id, 1, 'Codex-backed Dream message')
    writeDreamOutput({ ops: [] })

    await tickDreamSchedulerReady(Date.now(), { ensureActive: false })

    expect(readFileSync(commandFile, 'utf8')).toBe('codex exec --sandbox read-only -')
    expect(readFileSync(inputFile, 'utf8')).toContain('Codex-backed Dream message 0')
    const history = await listDreamRuns(workspace.id)
    expect(history.status).toBe(200)
    expect(history.body.runs).toContainEqual(
      expect.objectContaining({ error: null, status: 'completed', trigger: 'scheduled' })
    )
  })

  test('scheduled background dream failures are isolated and retry after the floor', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    recordUserInputs(workspace.id, 1, 'Retry failed-window message')
    const baseNow = Date.now()

    const listScheduled = () => {
      const db = openRuntimeDb()
      try {
        return db
          .prepare(
            "SELECT error, status FROM dream_runs WHERE workspace_id = ? AND trigger = 'scheduled' ORDER BY started_at ASC"
          )
          .all(workspace.id) as Array<{ error: string | null; status: string }>
      } finally {
        db.close()
      }
    }

    writeDreamOutput('not json')
    await tickDreamSchedulerReady(baseNow, { ensureActive: false })
    expect(listScheduled()).toEqual([
      { error: 'Dream CLI output was not valid JSON', status: 'failed' },
    ])

    writeDreamOutput({ ops: [] })
    await server.store.tickMemoryDreamScheduler(
      baseNow + DREAM_SCHEDULER_FLOOR_MS + DREAM_SCHEDULER_IDLE_DEBOUNCE_MS + 1
    )
    expect(listScheduled()).toEqual([
      { error: 'Dream CLI output was not valid JSON', status: 'failed' },
      { error: null, status: 'completed' },
    ])
  })

  test('scheduled tick runs when a single real message is pending', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    recordUserInputs(workspace.id, 1)
    writeDreamOutput({ ops: [] })

    await tickDreamSchedulerReady()

    const db = openRuntimeDb()
    try {
      expect(
        (
          db
            .prepare('SELECT COUNT(*) AS count FROM dream_runs WHERE workspace_id = ?')
            .get(workspace.id) as { count: number }
        ).count
      ).toBe(1)
    } finally {
      db.close()
    }
  })

  test('scheduled tick ignores system-only messages for the threshold', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const orchestrator = server.store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    const db = openRuntimeDb()
    try {
      for (let index = 0; index < 20; index += 1) {
        db.prepare(
          `INSERT INTO messages (
            workspace_id,
            worker_id,
            type,
            from_agent_id,
            to_agent_id,
            text,
            status,
            artifacts,
            created_at
          ) VALUES (?, ?, 'system_env_sync', NULL, NULL, ?, NULL, NULL, ?)`
        ).run(workspace.id, orchestrator.id, `System-only message ${index}`, Date.now())
      }
    } finally {
      db.close()
    }
    writeDreamOutput({ ops: [] })

    await tickDreamSchedulerReady()

    expect(existsSync(inputFile)).toBe(false)
  })

  test('scheduled tick excludes system messages from a mixed dream input window', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const orchestrator = server.store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    recordUserInputs(workspace.id, 10, 'Mixed real message before')
    const db = openRuntimeDb()
    try {
      db.prepare(
        `INSERT INTO messages (
          workspace_id,
          worker_id,
          type,
          from_agent_id,
          to_agent_id,
          text,
          status,
          artifacts,
          created_at
        ) VALUES (?, ?, 'system_env_sync', NULL, NULL, ?, NULL, NULL, ?)`
      ).run(workspace.id, orchestrator.id, 'Mixed internal system message', Date.now())
    } finally {
      db.close()
    }
    recordUserInputs(workspace.id, 10, 'Mixed real message after')
    writeDreamOutput({ ops: [] })

    await tickDreamSchedulerReady()

    const prompt = readFileSync(inputFile, 'utf8')
    expect(prompt).toContain('Mixed real message before 0')
    expect(prompt).toContain('Mixed real message after 9')
    expect(prompt).not.toContain('Mixed internal system message')
    expect(prompt).not.toContain('system_env_sync')
  })

  test('scheduled tick skips workspaces with a working agent', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const worker = server.store.addWorker(workspace.id, { name: 'Busy', role: 'coder' })
    server.store.getWorker(workspace.id, worker.id).status = 'idle'
    await server.store.dispatchTask(workspace.id, worker.id, 'Keep this worker busy.', {
      autoStartWorker: false,
    })
    recordUserInputs(workspace.id, 20)
    writeDreamOutput({ ops: [] })

    await server.store.tickMemoryDreamScheduler(1_000_000)

    expect(server.store.getWorker(workspace.id, worker.id)).toEqual(
      expect.objectContaining({ status: 'working' })
    )
    expect(existsSync(inputFile)).toBe(false)
  })

  test('scheduled tick skips workspaces that already have a running dream run', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    recordUserInputs(workspace.id, 20)
    writeDreamOutput({ ops: [] })

    const pending = triggerDream(workspace.id, { autoApply: false })
    await pending
    await server.store.tickMemoryDreamScheduler(1_000_000)

    const db = openRuntimeDb()
    try {
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM dream_runs WHERE workspace_id = ? AND trigger = 'scheduled'"
            )
            .get(workspace.id) as { count: number }
        ).count
      ).toBe(0)
    } finally {
      db.close()
    }
  })

  test('scheduled tick recovers stale running dream rows before checking eligibility', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const db = openRuntimeDb()
    try {
      db.prepare(
        `INSERT INTO dream_runs (
          id,
          workspace_id,
          trigger,
          status,
          started_at,
          finished_at,
          input_seq_from,
          input_seq_to,
          report,
          revert_blob,
          error
        ) VALUES (?, ?, 'manual', 'running', ?, NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run('stale-running-dream', workspace.id, Date.now() - DREAM_RUNNING_STALE_MS - 1000)
    } finally {
      db.close()
    }
    recordUserInputs(workspace.id, 20)
    writeDreamOutput({ ops: [] })

    await tickDreamSchedulerReady()

    const verifyDb = openRuntimeDb()
    try {
      const rows = verifyDb
        .prepare('SELECT id, status, trigger, error FROM dream_runs ORDER BY started_at ASC')
        .all() as Array<{ error: string | null; id: string; status: string; trigger: string }>
      expect(rows).toEqual([
        {
          error: 'Dream run exceeded the stale running window',
          id: 'stale-running-dream',
          status: 'failed',
          trigger: 'manual',
        },
        expect.objectContaining({
          error: null,
          status: 'completed',
          trigger: 'scheduled',
        }),
      ])
    } finally {
      verifyDb.close()
    }
  })

  test('dream run history recovers stale running rows before listing UI history', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const workspacePath = server.store.getWorkspaceSnapshot(workspace.id).summary.path
    const db = openRuntimeDb()
    try {
      db.prepare(
        `INSERT INTO dream_runs (
          id,
          workspace_id,
          trigger,
          status,
          started_at,
          finished_at,
          input_seq_from,
          input_seq_to,
          report,
          revert_blob,
          error
        ) VALUES (?, ?, 'manual', 'running', ?, NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run('stale-history-dream', workspace.id, Date.now() - DREAM_RUNNING_STALE_MS - 1000)
    } finally {
      db.close()
    }

    const history = await listDreamRuns(workspace.id)

    expect(history.status).toBe(200)
    expect(history.body.runs).toEqual([
      expect.objectContaining({
        id: 'stale-history-dream',
        status: 'failed',
      }),
    ])
    await waitForAssertion(() => {
      const content = readFileSync(getMemoryFilePath(workspacePath), 'utf8')
      expect(content).toContain('[failed, manual')
      expect(content).toContain(`error: ${DREAM_STALE_ERROR}`)
    })
  })

  test('apply rejects stale running dream rows before completing ops', async () => {
    if (!server) throw new Error('Expected test server')
    const activeServer = server
    const workspace = createWorkspace()
    const workspacePath = server.store.getWorkspaceSnapshot(workspace.id).summary.path
    const db = openRuntimeDb()
    try {
      db.prepare(
        `INSERT INTO dream_runs (
          id,
          workspace_id,
          trigger,
          status,
          started_at,
          finished_at,
          input_seq_from,
          input_seq_to,
          report,
          revert_blob,
          error
        ) VALUES (?, ?, 'manual', 'running', ?, NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run('stale-apply-dream', workspace.id, Date.now() - DREAM_RUNNING_STALE_MS - 1000)
    } finally {
      db.close()
    }

    expect(() =>
      activeServer.store.applyMemoryDreamRun(workspace.id, 'stale-apply-dream', [])
    ).toThrow('Dream run is no longer running')

    const verifyDb = openRuntimeDb()
    try {
      expect(
        verifyDb
          .prepare('SELECT status, error FROM dream_runs WHERE id = ?')
          .get('stale-apply-dream')
      ).toEqual({
        error: DREAM_STALE_ERROR,
        status: 'failed',
      })
    } finally {
      verifyDb.close()
    }
    await waitForAssertion(() => {
      const content = readFileSync(getMemoryFilePath(workspacePath), 'utf8')
      expect(content).toContain('[failed, manual')
      expect(content).toContain(`error: ${DREAM_STALE_ERROR}`)
    })
  })

  test('overlapping scheduled ticks do not start duplicate runs', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    recordUserInputs(workspace.id, 20)
    writeDreamOutput({ ops: [] })
    const baseNow = Date.now()

    await server.store.tickMemoryDreamScheduler(baseNow)
    await Promise.all([
      server.store.tickMemoryDreamScheduler(baseNow + DREAM_SCHEDULER_IDLE_DEBOUNCE_MS + 1),
      server.store.tickMemoryDreamScheduler(baseNow + DREAM_SCHEDULER_IDLE_DEBOUNCE_MS + 1),
    ])

    const db = openRuntimeDb()
    try {
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM dream_runs WHERE workspace_id = ? AND trigger = 'scheduled'"
            )
            .get(workspace.id) as { count: number }
        ).count
      ).toBe(1)
    } finally {
      db.close()
    }
  })

  test('runtime close waits for scheduled dream background execution', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-dream-close-data-'))
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-dream-close-workspace-'))
    tempDirs.push(dataDir, workspacePath)
    const store = createRuntimeStore({ dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Dream Close Workspace')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      args: ['-e', 'process.stdin.resume()'],
      command: process.execPath,
    })
    for (let index = 0; index < 20; index += 1) {
      store.recordUserInput(workspace.id, orchestrator.id, `Close scheduler message ${index}`)
    }
    writeDreamOutput({ ops: [] })
    const runtimeDbPath = join(dataDir, 'runtime.sqlite')
    const baseNow = Date.now()

    await store.tickMemoryDreamScheduler(baseNow)
    const tick = store.tickMemoryDreamScheduler(baseNow + DREAM_SCHEDULER_IDLE_DEBOUNCE_MS + 1)
    await store.close()
    await tick

    const db = new Database(runtimeDbPath)
    try {
      const row = db
        .prepare('SELECT error, status, trigger FROM dream_runs WHERE workspace_id = ?')
        .get(workspace.id) as { error: string | null; status: string; trigger: string }
      expect(row).toEqual({
        error: null,
        status: 'completed',
        trigger: 'scheduled',
      })
    } finally {
      db.close()
    }
  })

  test('scheduled tick respects the workspace dream switch', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    server.store.settings.setAppState(
      workspaceMemoryDreamEnabledKey(workspace.id),
      serializeWorkspaceMemoryDreamEnabled(false)
    )
    recordUserInputs(workspace.id, 20)
    writeDreamOutput({ ops: [] })

    await tickDreamSchedulerReady()

    expect(existsSync(inputFile)).toBe(false)
  })

  test('scheduled tick respects the workspace memory switch', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    server.store.settings.setAppState(
      workspaceMemoryEnabledKey(workspace.id),
      serializeWorkspaceMemoryEnabled(false)
    )
    recordUserInputs(workspace.id, 20)
    writeDreamOutput({ ops: [] })

    await tickDreamSchedulerReady()

    expect(existsSync(inputFile)).toBe(false)
  })

  test('scheduled tick executes background dream work without halting later workspaces', async () => {
    if (!server) throw new Error('Expected test server')
    const failingWorkspace = createWorkspace()
    const nextWorkspace = createWorkspace()
    recordUserInputs(failingWorkspace.id, 20)
    recordUserInputs(nextWorkspace.id, 20)
    writeDreamOutput({ ops: [] })
    await ensureOrchestratorRunning(nextWorkspace.id)

    await tickDreamSchedulerReady(Date.now(), { ensureActive: false })

    const db = openRuntimeDb()
    try {
      const rows = db
        .prepare('SELECT workspace_id, trigger, status, error FROM dream_runs ORDER BY started_at')
        .all() as Array<{
        error: string | null
        status: string
        trigger: string
        workspace_id: string
      }>
      expect(rows).toEqual([
        {
          error: null,
          status: 'completed',
          trigger: 'scheduled',
          workspace_id: failingWorkspace.id,
        },
        {
          error: null,
          status: 'completed',
          trigger: 'scheduled',
          workspace_id: nextWorkspace.id,
        },
      ])
    } finally {
      db.close()
    }
  })

  test('scheduled tick retries a failed background window after the floor elapses', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    recordUserInputs(workspace.id, 20, 'Retry failed-window message')
    const baseNow = Date.now()

    writeDreamOutput('not json')
    await tickDreamSchedulerReady(baseNow, { ensureActive: false })
    writeDreamOutput({ ops: [] })
    await tickDreamSchedulerReady(
      baseNow + DREAM_SCHEDULER_FLOOR_MS + DREAM_SCHEDULER_IDLE_DEBOUNCE_MS + 1,
      { ensureActive: false }
    )

    const db = openRuntimeDb()
    try {
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM dream_runs WHERE workspace_id = ? AND trigger = 'scheduled'"
            )
            .get(workspace.id) as { count: number }
        ).count
      ).toBe(2)
      const rows = db
        .prepare(
          "SELECT status FROM dream_runs WHERE workspace_id = ? AND trigger = 'scheduled' ORDER BY started_at ASC"
        )
        .all(workspace.id) as Array<{ status: string }>
      expect(rows).toEqual([{ status: 'failed' }, { status: 'completed' }])
    } finally {
      db.close()
    }
    expect(readFileSync(inputFile, 'utf8')).toContain('Retry failed-window message 0')
  })

  test('scheduled tick retries a failed window with old and new evidence after the floor', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    recordUserInputs(workspace.id, 20, 'Old failed-window message')
    const baseNow = Date.now()

    writeDreamOutput('not json')
    await tickDreamSchedulerReady(baseNow, { ensureActive: false })
    recordUserInputs(workspace.id, 20, 'New post-failure message')
    writeDreamOutput({ ops: [] })
    await tickDreamSchedulerReady(
      baseNow + DREAM_SCHEDULER_FLOOR_MS + DREAM_SCHEDULER_IDLE_DEBOUNCE_MS + 1,
      { ensureActive: false }
    )

    const prompt = readFileSync(inputFile, 'utf8')
    expect(prompt).toContain('Old failed-window message 0')
    expect(prompt).toContain('New post-failure message 0')
  })

  test('revert rejects damaged revert data with 409 and no mutation', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const target = addActiveMemory(workspace.id, 'Original after damaged revert.', 'fact')
    writeDreamOutput({ ops: [{ body: 'Damaged revert rewrite.', id: target.id, op: 'rewrite' }] })
    const completed = await triggerDream(workspace.id)
    const db = openRuntimeDb()
    try {
      db.prepare('UPDATE dream_runs SET revert_blob = ? WHERE id = ?').run(
        '{not-valid-json',
        completed.body.run.id
      )
    } finally {
      db.close()
    }

    const rejected = await revertDream(workspace.id, completed.body.run.id)

    expect(rejected.status).toBe(409)
    expect(server.store.getMemoryEntry(workspace.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Damaged revert rewrite.', status: 'active' })
    )
  })

  test('revert rejects missing revert data with 409 and no mutation', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const target = addActiveMemory(workspace.id, 'Original after missing revert data.', 'fact')
    writeDreamOutput({ ops: [{ body: 'Missing data rewrite.', id: target.id, op: 'rewrite' }] })
    const completed = await triggerDream(workspace.id)
    const db = openRuntimeDb()
    try {
      db.prepare('UPDATE dream_runs SET revert_blob = NULL WHERE id = ?').run(completed.body.run.id)
    } finally {
      db.close()
    }

    const rejected = await revertDream(workspace.id, completed.body.run.id)

    expect(rejected.status).toBe(409)
    expect(server.store.getMemoryEntry(workspace.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Missing data rewrite.', status: 'active' })
    )
  })

  test('revert rejects malformed revert data shape with 409 and no mutation', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const target = addActiveMemory(workspace.id, 'Original after malformed shape.', 'fact')
    writeDreamOutput({ ops: [{ body: 'Malformed shape rewrite.', id: target.id, op: 'rewrite' }] })
    const completed = await triggerDream(workspace.id)
    const db = openRuntimeDb()
    try {
      db.prepare('UPDATE dream_runs SET revert_blob = ? WHERE id = ?').run(
        JSON.stringify({ added_entry_ids: [] }),
        completed.body.run.id
      )
    } finally {
      db.close()
    }

    const rejected = await revertDream(workspace.id, completed.body.run.id)

    expect(rejected.status).toBe(409)
    expect(server.store.getMemoryEntry(workspace.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Malformed shape rewrite.', status: 'active' })
    )
  })

  test('revert rejects revert data with invalid enum values', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const target = addActiveMemory(workspace.id, 'Original before invalid enum.', 'fact')
    writeDreamOutput({ ops: [{ body: 'Invalid enum rewrite.', id: target.id, op: 'rewrite' }] })
    const completed = await triggerDream(workspace.id)
    const db = openRuntimeDb()
    try {
      const row = db
        .prepare('SELECT revert_blob FROM dream_runs WHERE id = ?')
        .get(completed.body.run.id) as { revert_blob: string }
      const revertBlob = JSON.parse(row.revert_blob) as {
        prior_entries: Array<{ entry: { status: string } }>
      }
      const firstEntry = revertBlob.prior_entries[0]
      if (!firstEntry) throw new Error('Expected prior entry in revert blob')
      firstEntry.entry.status = 'invalid-status'
      db.prepare('UPDATE dream_runs SET revert_blob = ? WHERE id = ?').run(
        JSON.stringify(revertBlob),
        completed.body.run.id
      )
    } finally {
      db.close()
    }

    const rejected = await revertDream(workspace.id, completed.body.run.id)

    expect(rejected.status).toBe(409)
    expect(server.store.getMemoryEntry(workspace.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Invalid enum rewrite.', status: 'active' })
    )
  })

  test('revert rejects revert data with invalid boolean storage values', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const target = addActiveMemory(workspace.id, 'Original before invalid boolean.', 'fact')
    writeDreamOutput({ ops: [{ body: 'Invalid boolean rewrite.', id: target.id, op: 'rewrite' }] })
    const completed = await triggerDream(workspace.id)
    const db = openRuntimeDb()
    try {
      const row = db
        .prepare('SELECT revert_blob FROM dream_runs WHERE id = ?')
        .get(completed.body.run.id) as { revert_blob: string }
      const revertBlob = JSON.parse(row.revert_blob) as {
        prior_entries: Array<{ entry: { pinned: number } }>
      }
      const firstEntry = revertBlob.prior_entries[0]
      if (!firstEntry) throw new Error('Expected prior entry in revert blob')
      firstEntry.entry.pinned = 2
      db.prepare('UPDATE dream_runs SET revert_blob = ? WHERE id = ?').run(
        JSON.stringify(revertBlob),
        completed.body.run.id
      )
    } finally {
      db.close()
    }

    const rejected = await revertDream(workspace.id, completed.body.run.id)

    expect(rejected.status).toBe(409)
    expect(server.store.getMemoryEntry(workspace.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Invalid boolean rewrite.', status: 'active' })
    )
  })

  test('revert fails atomically when the final dream_runs status update fails', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const target = addActiveMemory(workspace.id, 'Original before final failure.', 'fact')
    writeDreamOutput({
      ops: [{ body: 'Reverted only if commit succeeds.', id: target.id, op: 'rewrite' }],
    })
    const completed = await triggerDream(workspace.id)
    const db = openRuntimeDb()
    try {
      db.exec(`
        CREATE TRIGGER fail_dream_revert
        BEFORE UPDATE OF status ON dream_runs
        WHEN new.status = 'reverted'
        BEGIN
          SELECT RAISE(FAIL, 'forced dream revert failure');
        END;
      `)
    } finally {
      db.close()
    }

    const rejected = await revertDream(workspace.id, completed.body.run.id)

    expect(rejected.status).toBe(500)
    expect(server.store.getMemoryEntry(workspace.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Reverted only if commit succeeds.', status: 'active' })
    )
  })

  test('revert fails atomically when an added dream entry is missing', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({ ops: [{ body: 'Missing dream add.', kind: 'fact', op: 'add' }] })
    const completed = await triggerDream(workspace.id)
    const dreamEntry = server.store
      .listMemoryEntries(workspace.id, { statuses: ['active'] })
      .find((memory) => memory.body === 'Missing dream add.')
    if (!dreamEntry) throw new Error('Expected dream entry')
    const db = openRuntimeDb()
    try {
      db.prepare('DELETE FROM memory_entries WHERE id = ?').run(dreamEntry.id)
    } finally {
      db.close()
    }

    const rejected = await revertDream(workspace.id, completed.body.run.id)

    expect(rejected.status).toBe(409)
    const row = openRuntimeDb()
    try {
      expect(
        (
          row.prepare('SELECT status FROM dream_runs WHERE id = ?').get(completed.body.run.id) as {
            status: string
          }
        ).status
      ).toBe('completed')
    } finally {
      row.close()
    }
  })

  test('invalid ops are rejected without partially inserting earlier valid ops', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({
      ops: [{ body: 'This must not be inserted.', kind: 'fact', op: 'add' }, { op: 'unsupported' }],
    })

    const result = await triggerDream(workspace.id, { autoApply: false })

    expect(result.status).toBe(200)
    expect(() => applyDreamFromOutput(workspace.id, result.body.run.id)).toThrow(
      'Unsupported dream op'
    )
    expect(getDreamRunAudit(result.body.run.id)).toEqual(
      expect.objectContaining({ error: null, report: null, status: 'running' })
    )
    expect(
      server.store
        .listMemoryEntries(workspace.id, { statuses: ['active'] })
        .find((memory) => memory.body === 'This must not be inserted.')
    ).toBeUndefined()
  })

  test('dream add sources must come from this run protocol input window', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const orchestrator = server.store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    server.store.recordUserInput(workspace.id, orchestrator.id, 'Allowed evidence before system')
    let systemSequence = 0
    const db = openRuntimeDb()
    try {
      const result = db
        .prepare(
          `INSERT INTO messages (
            workspace_id,
            worker_id,
            type,
            from_agent_id,
            to_agent_id,
            text,
            status,
            artifacts,
            created_at
          ) VALUES (?, ?, 'system_env_sync', NULL, NULL, ?, NULL, NULL, ?)`
        )
        .run(workspace.id, orchestrator.id, 'System evidence must not be citable', Date.now())
      systemSequence = Number(result.lastInsertRowid)
    } finally {
      db.close()
    }
    server.store.recordUserInput(workspace.id, orchestrator.id, 'Allowed evidence after system')
    writeDreamOutput({
      ops: [
        {
          body: 'This memory cites a system message and must fail.',
          kind: 'fact',
          op: 'add',
          sources: [{ sequence: systemSequence }],
        },
      ],
    })

    const result = await triggerDream(workspace.id, { autoApply: false })

    expect(result.status).toBe(200)
    expect(() => applyDreamFromOutput(workspace.id, result.body.run.id)).toThrow(
      'Dream op source is outside this run input'
    )
    expect(getDreamRunAudit(result.body.run.id)).toEqual(
      expect.objectContaining({ error: null, status: 'running' })
    )
    expect(
      server.store
        .listMemoryEntries(workspace.id, { statuses: ['active'] })
        .find((memory) => memory.body === 'This memory cites a system message and must fail.')
    ).toBeUndefined()
  })

  test('completion write failure rolls back already-applied memory operations', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const db = openRuntimeDb()
    try {
      db.exec(`
        CREATE TRIGGER fail_dream_completion
        BEFORE UPDATE OF status ON dream_runs
        WHEN new.status = 'completed'
        BEGIN
          SELECT RAISE(FAIL, 'forced dream completion failure');
        END;
      `)
    } finally {
      db.close()
    }
    writeDreamOutput({ ops: [{ body: 'Rollback this dream add.', kind: 'fact', op: 'add' }] })

    const result = await triggerDream(workspace.id, { autoApply: false })

    expect(() => applyDreamFromOutput(workspace.id, result.body.run.id)).toThrow(
      'forced dream completion failure'
    )
    expect(getDreamRunAudit(result.body.run.id)).toEqual(
      expect.objectContaining({ error: null, report: null, status: 'running' })
    )
    expect(
      server.store
        .listMemoryEntries(workspace.id, { statuses: ['active'] })
        .find((memory) => memory.body === 'Rollback this dream add.')
    ).toBeUndefined()
  })

  test('unknown ids and overlong bodies fail without mutating memory', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({ ops: [{ id: 'missing-memory', op: 'archive' }] })

    const unknown = await triggerDream(workspace.id, { autoApply: false })

    expect(() => applyDreamFromOutput(workspace.id, unknown.body.run.id)).toThrow(
      'Dream op memory id is outside this workspace'
    )
    expect(getDreamRunAudit(unknown.body.run.id)).toEqual(
      expect.objectContaining({ error: null, status: 'running' })
    )
    const overlongWorkspace = createWorkspace()
    writeDreamOutput({ ops: [{ body: 'x'.repeat(501), kind: 'fact', op: 'add' }] })

    const overlong = await triggerDream(overlongWorkspace.id, { autoApply: false })

    expect(() => applyDreamFromOutput(overlongWorkspace.id, overlong.body.run.id)).toThrow(
      'Dream op body must be 500 characters or fewer'
    )
    expect(server.store.listMemoryEntries(workspace.id, { statuses: ['active'] })).toEqual([])
    expect(server.store.listMemoryEntries(overlongWorkspace.id, { statuses: ['active'] })).toEqual(
      []
    )
  })

  test('cross-workspace ids fail the run without mutating either workspace', async () => {
    if (!server) throw new Error('Expected test server')
    const left = createWorkspace()
    const right = createWorkspace()
    const rightMemory = addActiveMemory(right.id, 'Right workspace only.', 'decision')
    writeDreamOutput({ ops: [{ id: rightMemory.id, op: 'archive' }] })

    const result = await triggerDream(left.id, { autoApply: false })

    expect(result.status).toBe(200)
    expect(() => applyDreamFromOutput(left.id, result.body.run.id)).toThrow(
      'Dream op memory id is outside this workspace'
    )
    expect(getDreamRunAudit(result.body.run.id)).toEqual(
      expect.objectContaining({ error: null, report: null, status: 'running' })
    )
    expect(server.store.getMemoryEntry(right.id, rightMemory.id)).toEqual(
      expect.objectContaining({ status: 'active' })
    )
  })

  test('more than ten add ops fail without inserting any dream memories', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({
      ops: Array.from({ length: 11 }, (_, index) => ({
        body: `Excess dream memory ${index}`,
        kind: 'fact',
        op: 'add',
      })),
    })

    const result = await triggerDream(workspace.id, { autoApply: false })

    expect(result.status).toBe(200)
    expect(() => applyDreamFromOutput(workspace.id, result.body.run.id)).toThrow(
      'Dream run can add at most 10 memories'
    )
    expect(getDreamRunAudit(result.body.run.id)).toEqual(
      expect.objectContaining({ error: null, report: null, status: 'running' })
    )
    expect(server.store.listMemoryEntries(workspace.id, { statuses: ['active'] })).toEqual([])
  })

  test('manual trigger respects the workspace dream switch before injecting maintenance', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    server.store.settings.setAppState(
      workspaceMemoryDreamEnabledKey(workspace.id),
      serializeWorkspaceMemoryDreamEnabled(false)
    )
    writeDreamOutput({ ops: [{ body: 'Disabled dream must not run.', kind: 'fact', op: 'add' }] })

    const response = await uiFetch(`/api/ui/workspaces/${workspace.id}/memory/dream-runs`, {
      body: JSON.stringify({}),
      method: 'POST',
    })

    expect(response.status).toBe(409)
    expect(server.store.listMemoryEntries(workspace.id, { statuses: ['active'] })).toEqual([])
    expect(existsSync(inputFile)).toBe(false)
    expect(existsSync(commandFile)).toBe(false)
  })

  test('manual trigger respects the workspace memory switch before injecting maintenance', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    server.store.settings.setAppState(
      workspaceMemoryEnabledKey(workspace.id),
      serializeWorkspaceMemoryEnabled(false)
    )
    writeDreamOutput({ ops: [{ body: 'Disabled memory must not run.', kind: 'fact', op: 'add' }] })

    const response = await uiFetch(`/api/ui/workspaces/${workspace.id}/memory/dream-runs`, {
      body: JSON.stringify({}),
      method: 'POST',
    })

    expect(response.status).toBe(409)
    expect(server.store.listMemoryEntries(workspace.id, { statuses: ['active'] })).toEqual([])
    expect(existsSync(inputFile)).toBe(false)
    expect(existsSync(commandFile)).toBe(false)
  })

  test('manual trigger fails when the orchestrator is not running', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({
      ops: [{ body: 'Inactive orchestrator dream must not run.', kind: 'fact', op: 'add' }],
    })

    const result = await triggerDream(workspace.id, { autoApply: false, ensureActive: false })

    expect(result.status).toBe(409)
    expect(result.body.run).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('No active run for agent'),
        report: null,
        status: 'failed',
      })
    )
    expect(server.store.listMemoryEntries(workspace.id, { statuses: ['active'] })).toEqual([])
    expect(existsSync(inputFile)).toBe(false)
    expect(existsSync(commandFile)).toBe(false)
  })

  test('manual trigger keeps the run pending until orchestrator applies ops', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({ ops: [] })

    const result = await triggerDream(workspace.id, { autoApply: false })

    expect(result.body.run).toEqual(expect.objectContaining({ status: 'running' }))
    expect(existsSync(commandFile)).toBe(false)
    expect(existsSync(envFile)).toBe(false)
  })

  test('dream show excludes memory entries created after the run started', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const result = await triggerDream(workspace.id, { autoApply: false })
    const lateMemory = addActiveMemory(
      workspace.id,
      'Late memory must wait for the next Dream run.'
    )
    bumpMemoryUpdatedAt(lateMemory.id, getDreamRunStartedAt(result.body.run.id) + 1)

    const input = server.store.getMemoryDreamInput(workspace.id, result.body.run.id)

    expect(input.prompt).not.toContain('Late memory must wait for the next Dream run.')
  })

  test('apply rejects ops touching memory changed after the run started', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const target = addActiveMemory(workspace.id, 'Original memory before Dream run.')
    const result = await triggerDream(workspace.id, { autoApply: false })
    server.store.archiveMemoryEntry(workspace.id, target.id)
    writeDreamOutput({
      ops: [{ body: 'Dream must not revive this.', id: target.id, op: 'rewrite' }],
    })

    expect(() => applyDreamFromOutput(workspace.id, result.body.run.id)).toThrow(
      'Dream op memory changed after this run started'
    )
    expect(server.store.getMemoryEntry(workspace.id, target.id)).toEqual(
      expect.objectContaining({ body: 'Original memory before Dream run.', status: 'archived' })
    )
  })

  test('manual trigger completes through the orchestrator apply path', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({
      ops: [{ body: 'Applied by orchestrator maintenance.', kind: 'fact', op: 'add' }],
    })

    const result = await triggerDream(workspace.id)

    expect(result.body.run).toEqual(expect.objectContaining({ status: 'completed' }))
    expect(server.store.listMemoryEntries(workspace.id, { statuses: ['active'] })).toContainEqual(
      expect.objectContaining({ body: 'Applied by orchestrator maintenance.', source: 'dream' })
    )
  })

  test('concurrent manual trigger returns 409 instead of starting a duplicate run', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({ ops: [] })

    const first = await triggerDream(workspace.id, { autoApply: false })
    const second = await uiFetch(`/api/ui/workspaces/${workspace.id}/memory/dream-runs`, {
      body: JSON.stringify({}),
      method: 'POST',
    })

    expect(second.status).toBe(409)
    expect(first.status).toBe(200)
  })

  test('manual trigger returns 409 when the database already has a fresh running run', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const db = openRuntimeDb()
    try {
      db.prepare(
        `INSERT INTO dream_runs (
          id,
          workspace_id,
          trigger,
          status,
          started_at,
          finished_at,
          input_seq_from,
          input_seq_to,
          report,
          revert_blob,
          error
        ) VALUES (?, ?, 'manual', 'running', ?, NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run('fresh-running-dream', workspace.id, Date.now())
    } finally {
      db.close()
    }
    writeDreamOutput({ ops: [] })

    const response = await triggerDream(workspace.id)

    expect(response.status).toBe(409)
    expect(existsSync(inputFile)).toBe(false)
    const verifyDb = openRuntimeDb()
    try {
      expect(
        (
          verifyDb
            .prepare('SELECT COUNT(*) AS count FROM dream_runs WHERE workspace_id = ?')
            .get(workspace.id) as { count: number }
        ).count
      ).toBe(1)
    } finally {
      verifyDb.close()
    }
  })

  test('workspace deletion during a dream run prevents orphan memory writes', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    writeDreamOutput({ ops: [{ body: 'No orphan memory after delete.', kind: 'fact', op: 'add' }] })

    const pending = await triggerDream(workspace.id, { autoApply: false })
    await server.store.deleteWorkspace(workspace.id)

    expect(pending.body.run).toEqual(
      expect.objectContaining({
        error: null,
        status: 'running',
      })
    )
    const db = openRuntimeDb()
    try {
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM memory_entries WHERE body = 'No orphan memory after delete.'"
            )
            .get() as { count: number }
        ).count
      ).toBe(0)
    } finally {
      db.close()
    }
  })

  test('deleted workspaces cannot create orphan failed dream runs', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    await server.store.deleteWorkspace(workspace.id)

    let caught: unknown
    try {
      await server.store.runMemoryDream(workspace.id)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DreamWorkspaceMissingError)
    expect(caught).toMatchObject({ workspaceId: workspace.id })
    const db = openRuntimeDb()
    try {
      expect(
        (
          db
            .prepare('SELECT COUNT(*) AS count FROM dream_runs WHERE workspace_id = ?')
            .get(workspace.id) as { count: number }
        ).count
      ).toBe(0)
    } finally {
      db.close()
    }
  })
})
