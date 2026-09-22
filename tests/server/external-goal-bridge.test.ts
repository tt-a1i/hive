import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import { callHiveMcpTool, HIVE_MCP_TOOL_NAMES } from '../../src/cli/hive-mcp.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { HIVE_SUPERVISOR_TOKEN_HEADER } from '../../src/server/external-goal-auth.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalEnv = { ...process.env }

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

const runTeamBinaryWithStdin = (
  args: string[],
  env: Record<string, string>,
  stdinContent: string
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    )
    child.stdin.write(stdinContent)
    child.stdin.end()
  })

const callHiveMcpProcess = async (
  baseUrl: string,
  requests: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/hive.ts', 'mcp', '--base-url', baseUrl],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`hive mcp exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`)
        )
        return
      }
      const messages = Buffer.concat(stdout)
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      resolve(messages)
    })
    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`)
    }
    child.stdin.end()
  })

const getSupervisorToken = async (baseUrl: string) => {
  const response = await fetch(`${baseUrl}/api/external-goals/session`)
  const body = (await response.json()) as { token?: unknown }
  if (typeof body.token !== 'string') {
    throw new Error('Expected Supervisor token')
  }
  return body.token
}

interface SetupContext {
  baseUrl: string
  dataDir: string
  hive: Awaited<ReturnType<typeof runHiveCommand>>
  orchestratorId: string
  orchestratorRunId: string
  uiCookie: string
  workspace: { id: string }
  workspacePath: string
}

const setupHiveWithPassiveOrchestrator = async (
  options: { startOrchestrator?: boolean } = {}
): Promise<SetupContext> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-external-goal-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)

  const orchScript = join(workspacePath, 'orch-echo.js')
  writeFileSync(
    orchScript,
    [
      'process.stdin.setRawMode(true)',
      "process.stdin.on('data', bytes => {",
      '  for (let offset = 0; offset < bytes.length; offset += 16)',
      "    process.stdout.write('RECEIVED_HEX:' + bytes.subarray(offset, offset + 16).toString('hex') + ':END\\r\\n')",
      '})',
    ].join('\n')
  )

  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const uiCookie = await getUiCookie(baseUrl)
  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  const orchestratorId = `${workspace.id}:orchestrator`

  await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ command: process.execPath, args: [orchScript] }),
  })
  let orchestratorRunId = ''
  if (options.startOrchestrator ?? true) {
    const startResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      }
    )
    const start = (await startResponse.json()) as { run_id: string }
    orchestratorRunId = start.run_id
  }
  return {
    baseUrl,
    dataDir,
    hive,
    orchestratorId,
    orchestratorRunId,
    uiCookie,
    workspace,
    workspacePath,
  }
}

const readReceivedInput = async (
  baseUrl: string,
  runId: string,
  cookie: string
): Promise<string> => {
  const response = await fetch(`${baseUrl}/api/runtime/runs/${runId}`, {
    headers: { cookie },
  })
  const body = (await response.json()) as { output: string }
  // The real PTY receiver emits short encoded receipts, so Windows screen
  // wrapping cannot be mistaken for corruption of the delivered input.
  return Buffer.concat(
    [...body.output.matchAll(/RECEIVED_HEX:([0-9a-f]+):END/g)].map((match) => {
      const hex = match[1]
      if (hex === undefined) throw new Error('Missing receiver hex capture')
      return Buffer.from(hex, 'hex')
    })
  ).toString('utf8')
}

afterEach(() => {
  process.env = { ...originalEnv }
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('Hive external goal bridge', () => {
  test('MCP tool list exposes only Supervisor goal operations', () => {
    expect(HIVE_MCP_TOOL_NAMES).toEqual([
      'hive.list_workspaces',
      'hive.inspect_workspace',
      'hive.start_goal',
      'hive.wait_goal',
      'hive.continue_goal',
      'hive.cancel_goal',
    ])
    expect(HIVE_MCP_TOOL_NAMES).not.toContain('hive.send_to_member')
    expect(HIVE_MCP_TOOL_NAMES).not.toContain('hive.spawn_member')
    expect(HIVE_MCP_TOOL_NAMES).not.toContain('hive.write_pty')
  })

  test('start/wait/continue/cancel flows through durable events and Orchestrator stdin', async () => {
    const ctx = await setupHiveWithPassiveOrchestrator()
    try {
      const uiCookieOnly = await fetch(`${ctx.baseUrl}/api/external-goals/workspaces`, {
        headers: { cookie: ctx.uiCookie },
      })
      expect(uiCookieOnly.status).toBe(403)

      const listed = (await callHiveMcpTool(
        'hive.list_workspaces',
        {},
        { baseUrl: ctx.baseUrl }
      )) as {
        workspaces: Array<{ id: string }>
      }
      expect(listed.workspaces.some((workspace) => workspace.id === ctx.workspace.id)).toBe(true)

      const inspected = (await callHiveMcpTool(
        'hive.inspect_workspace',
        { workspace_id: ctx.workspace.id },
        { baseUrl: ctx.baseUrl }
      )) as { orchestrator: { active_run: boolean }; members: unknown[] }
      expect(inspected.orchestrator.active_run).toBe(true)
      expect(inspected.members).toEqual([])

      const started = (await callHiveMcpTool(
        'hive.start_goal',
        {
          context: { source_thread: 'codex-test' },
          goal: 'Review the current diff and report the highest-risk issue.',
          workspace_id: ctx.workspace.id,
        },
        { baseUrl: ctx.baseUrl }
      )) as { cursor: number; goal_id: string; status: string }
      expect(started.goal_id).toMatch(/^goal_/)
      expect(started.status).toBe('in_progress')

      await waitFor(async () => {
        const output = await readReceivedInput(ctx.baseUrl, ctx.orchestratorRunId, ctx.uiCookie)
        expect(output).toContain('<hive-message kind="external-goal"')
        expect(output).toContain(`goal_id="${started.goal_id}"`)
        expect(output).toContain('Review the current diff')
        expect(output).toContain(`team goal report --goal ${started.goal_id} --status done --stdin`)
        expect(output).not.toContain('<hive-system-reminder>')
      })

      const firstWait = (await callHiveMcpTool(
        'hive.wait_goal',
        { cursor: 0, goal_id: started.goal_id, timeout_ms: 1 },
        { baseUrl: ctx.baseUrl }
      )) as { cursor: number; events: Array<{ kind: string; sequence: number }>; status: string }
      expect(firstWait.events.map((event) => event.kind)).toEqual([
        'goal_started',
        'goal_delivered',
      ])
      expect(firstWait.cursor).toBe(2)

      const emptyWait = (await callHiveMcpTool(
        'hive.wait_goal',
        { cursor: firstWait.cursor, goal_id: started.goal_id, timeout_ms: 5 },
        { baseUrl: ctx.baseUrl }
      )) as { cursor: number; events: unknown[] }
      expect(emptyWait.events).toEqual([])
      expect(emptyWait.cursor).toBe(firstWait.cursor)

      const continued = (await callHiveMcpTool(
        'hive.continue_goal',
        {
          context: { reviewer_count: 2 },
          goal_id: started.goal_id,
          message: 'Please include a short validation plan.',
        },
        { baseUrl: ctx.baseUrl }
      )) as { cursor: number; event: { kind: string }; status: string }
      expect(continued.event.kind).toBe('goal_continued')
      expect(continued.status).toBe('in_progress')

      await waitFor(async () => {
        const output = await readReceivedInput(ctx.baseUrl, ctx.orchestratorRunId, ctx.uiCookie)
        expect(output).toContain('<hive-message kind="external-goal-continue"')
        expect(output).toContain('Please include a short validation plan.')
      })

      const cancelled = (await callHiveMcpTool(
        'hive.cancel_goal',
        { goal_id: started.goal_id, reason: 'User stopped the external request.' },
        { baseUrl: ctx.baseUrl }
      )) as { event: { kind: string }; status: string }
      expect(cancelled.event.kind).toBe('goal_cancelled')
      expect(cancelled.status).toBe('cancelled')

      await waitFor(async () => {
        const output = await readReceivedInput(ctx.baseUrl, ctx.orchestratorRunId, ctx.uiCookie)
        expect(output).toContain('<hive-message kind="external-goal-cancel"')
        expect(output).toContain('User stopped the external request.')
      })
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('start_goal persists a delivery failure when Orchestrator is stopped', async () => {
    const ctx = await setupHiveWithPassiveOrchestrator({ startOrchestrator: false })
    try {
      const supervisorToken = await getSupervisorToken(ctx.baseUrl)
      const response = await fetch(`${ctx.baseUrl}/api/external-goals/start`, {
        method: 'POST',
        headers: {
          [HIVE_SUPERVISOR_TOKEN_HEADER]: supervisorToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          goal: 'This should fail because Orchestrator is stopped.',
          workspace_id: ctx.workspace.id,
        }),
      })
      expect(response.status).toBe(409)
      const body = (await response.json()) as {
        cursor: number
        goal_id: string
        status: string
      }
      expect(body.goal_id).toMatch(/^goal_/)
      expect(body.cursor).toBe(2)
      expect(body.status).toBe('failed')

      const waited = (await callHiveMcpTool(
        'hive.wait_goal',
        { cursor: 0, goal_id: body.goal_id, timeout_ms: 1 },
        { baseUrl: ctx.baseUrl }
      )) as { events: Array<{ kind: string; status: string }>; status: string }
      expect(waited.status).toBe('failed')
      expect(waited.events).toEqual([
        expect.objectContaining({ kind: 'goal_started', status: 'open' }),
        expect.objectContaining({ kind: 'delivery_failed', status: 'failed' }),
      ])
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('hive mcp stdio serves tools and keeps request ids on tool errors', async () => {
    const ctx = await setupHiveWithPassiveOrchestrator({ startOrchestrator: false })
    try {
      const responses = await callHiveMcpProcess(ctx.baseUrl, [
        {
          id: 1,
          jsonrpc: '2.0',
          method: 'initialize',
          params: { protocolVersion: '2025-06-18' },
        },
        { id: 2, jsonrpc: '2.0', method: 'tools/list' },
        {
          id: 3,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            arguments: { goal: 'Expect structured failure.', workspace_id: ctx.workspace.id },
            name: 'hive.start_goal',
          },
        },
      ])

      expect(responses).toHaveLength(3)
      expect(responses[0]).toEqual(
        expect.objectContaining({
          id: 1,
          jsonrpc: '2.0',
          result: expect.objectContaining({
            capabilities: { tools: {} },
          }),
        })
      )
      expect(responses[1]).toEqual(
        expect.objectContaining({
          id: 2,
          result: expect.objectContaining({
            tools: expect.arrayContaining([
              expect.objectContaining({ name: 'hive.start_goal' }),
              expect.objectContaining({ name: 'hive.wait_goal' }),
            ]),
          }),
        })
      )
      expect(responses[2]).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: -32603,
            message: expect.stringContaining('orchestrator_not_running'),
          }),
          id: 3,
          jsonrpc: '2.0',
        })
      )
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)

  test('only Orchestrator can report external goal progress and completion', async () => {
    const ctx = await setupHiveWithPassiveOrchestrator()
    try {
      const workerResponse = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspace.id}/workers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: ctx.uiCookie },
          body: JSON.stringify({ name: 'Alice', role: 'coder' }),
        }
      )
      const worker = (await workerResponse.json()) as { id: string }
      const inspected = (await callHiveMcpTool(
        'hive.inspect_workspace',
        { workspace_id: ctx.workspace.id },
        { baseUrl: ctx.baseUrl }
      )) as { members: Array<Record<string, unknown>> }
      expect(inspected.members[0]).toEqual(
        expect.objectContaining({
          command_preset_id: null,
          last_pty_line: null,
          pending_task_count: 0,
        })
      )
      expect(inspected.members[0]).not.toHaveProperty('pendingTaskCount')
      expect(inspected.members[0]).not.toHaveProperty('lastPtyLine')

      await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspace.id}/agents/${worker.id}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ctx.uiCookie },
        body: JSON.stringify({
          command: process.execPath,
          args: ['-e', 'process.stdin.resume()'],
        }),
      })
      await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ctx.uiCookie },
        body: JSON.stringify({ hive_port: String(ctx.hive.port) }),
      })

      const started = (await callHiveMcpTool(
        'hive.start_goal',
        { goal: 'Coordinate a focused review.', workspace_id: ctx.workspace.id },
        { baseUrl: ctx.baseUrl }
      )) as { cursor: number; goal_id: string }

      const orchestratorToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchestratorToken) throw new Error('Expected orchestrator token')
      const workerToken = ctx.hive.store.peekAgentToken(worker.id)
      if (!workerToken) throw new Error('Expected worker token')

      process.env = {
        ...originalEnv,
        HIVE_AGENT_ID: ctx.orchestratorId,
        HIVE_AGENT_TOKEN: orchestratorToken,
        HIVE_DATA_DIR: ctx.dataDir,
        HIVE_PORT: String(ctx.hive.port),
        HIVE_PROJECT_ID: ctx.workspace.id,
      }
      await runTeamCommand([
        'goal',
        'report',
        '--goal',
        started.goal_id,
        '--status',
        'progress',
        'Dispatched review and test members.',
      ])

      const progress = (await callHiveMcpTool(
        'hive.wait_goal',
        { cursor: started.cursor, goal_id: started.goal_id, timeout_ms: 1 },
        { baseUrl: ctx.baseUrl }
      )) as { cursor: number; events: Array<{ body: string; kind: string; status: string }> }
      expect(progress.events).toContainEqual(
        expect.objectContaining({
          body: 'Dispatched review and test members.',
          kind: 'progress_reported',
          status: 'progress',
        })
      )

      process.env = {
        ...originalEnv,
        HIVE_AGENT_ID: worker.id,
        HIVE_AGENT_TOKEN: workerToken,
        HIVE_DATA_DIR: ctx.dataDir,
        HIVE_PORT: String(ctx.hive.port),
        HIVE_PROJECT_ID: ctx.workspace.id,
      }
      await expect(
        runTeamCommand([
          'goal',
          'report',
          '--goal',
          started.goal_id,
          '--status',
          'progress',
          'Worker should not be allowed.',
        ])
      ).rejects.toThrow(/not allowed to run team goal_report/u)

      const doneBody = ['Done.', '', 'Validation:', '- pnpm check', '- focused vitest'].join('\n')
      const done = await runTeamBinaryWithStdin(
        ['goal', 'report', '--goal', started.goal_id, '--status', 'done', '--stdin'],
        {
          HIVE_AGENT_ID: ctx.orchestratorId,
          HIVE_AGENT_TOKEN: orchestratorToken,
          HIVE_DATA_DIR: ctx.dataDir,
          HIVE_PORT: String(ctx.hive.port),
          HIVE_PROJECT_ID: ctx.workspace.id,
        },
        doneBody
      )
      expect(done.code).toBe(0)

      const completion = (await callHiveMcpTool(
        'hive.wait_goal',
        { cursor: progress.cursor, goal_id: started.goal_id, timeout_ms: 1 },
        { baseUrl: ctx.baseUrl }
      )) as { events: Array<{ body: string; kind: string; status: string }>; status: string }
      expect(completion.status).toBe('done')
      expect(completion.events).toContainEqual(
        expect.objectContaining({
          body: doneBody,
          kind: 'goal_done',
          status: 'done',
        })
      )
    } finally {
      await ctx.hive.close()
    }
  }, 20_000)
})
