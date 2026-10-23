import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import type { TeamListItemPayload } from '../../src/shared/types.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH

const writeSlowHermesCli = (binDir: string, promptDelayMs = 350) => {
  mkdirSync(binDir, { recursive: true })
  const scriptPath = join(binDir, 'fake-hermes.js')
  writeFileSync(
    scriptPath,
    [
      "process.stdin.setEncoding('utf8')",
      'if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true)',
      "const PASTE_END = '\\u001b[201~'",
      "let buffer = ''",
      'let pasted = false',
      "process.stdout.write('Hermes booting before prompt readiness\\n')",
      `setTimeout(() => process.stdout.write('Welcome to Hermes Agent! Type your message or /help for commands.\\n❯ '), ${promptDelayMs})`,
      "process.stdin.on('data', (chunk) => {",
      '  buffer += chunk',
      "  process.stdout.write('IN:' + chunk)",
      '  const pasteEnd = buffer.indexOf(PASTE_END)',
      "  if (!pasted && (pasteEnd >= 0 || (process.platform === 'win32' && buffer.includes('</hive-message>')))) {",
      '    pasted = true',
      '    const kind = buffer.match(/<hive-message kind="([^"]+)"/)?.[1] || \'unknown\'',
      '    const dispatch = buffer.match(/dispatch_id: ([^\\r\\n]+)/)?.[1]',
      "    process.stdout.write('\\nKIND:' + kind + (dispatch ? ':' + dispatch : '') + '\\n❯ ')",
      '  }',
      '  const submitInput = pasteEnd >= 0 ? buffer.slice(pasteEnd + PASTE_END.length) : chunk',
      '  if (pasted && /^[\\r\\n]+$/.test(submitInput)) {',
      "    process.stdout.write('\\nSUBMITTED\\n❯ ')",
      "    buffer = ''",
      '    pasted = false',
      '  }',
      '})',
      'process.stdin.resume()',
      'setInterval(() => {}, 1 << 30)',
    ].join('\n')
  )
  const unixCli = join(binDir, 'hermes')
  writeFileSync(unixCli, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
  chmodSync(unixCli, 0o755)
  const winCli = join(binDir, 'hermes.cmd')
  writeFileSync(winCli, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`)
}

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 5000) => {
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

afterEach(async () => {
  delete process.env.HIVE_DATA_DIR
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('queued dispatch to a stopped worker (#33)', () => {
  test('send parks with queued:true, team list shows it, and starting the worker delivers it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-queued-replay-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    const passiveScript = join(workspacePath, 'passive.js')
    writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)

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

      // Configure BOTH agents; start only the orchestrator — Alice stays stopped.
      for (const agentId of [orchestratorId, worker.id]) {
        await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ command: process.execPath, args: [passiveScript] }),
        })
      }
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })
      const orchToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token after start')

      // 1. team send to the STOPPED worker → parked, and the response says so.
      const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: orchToken,
          to: 'Alice',
          text: 'implement login',
        }),
      })
      expect(sendResponse.status).toBe(202)
      const sent = (await sendResponse.json()) as {
        dispatch_id: string
        queued?: boolean
        worker_status?: string
        restarted_worker?: boolean
      }
      expect(sent.queued).toBe(true)
      expect(sent.worker_status).toBe('stopped')
      expect(sent.restarted_worker).toBe(false)

      const parked = hive.store
        .listDispatches(workspace.id)
        .find((item) => item.id === sent.dispatch_id)
      expect(parked?.status).toBe('queued')
      expect(parked?.submittedAt).toBeNull()

      // A workflow-owned dispatch parked on the same worker must stay the
      // runner's business: invisible in team list and untouched by replay.
      const workflowDispatch = await hive.store.dispatchTask(
        workspace.id,
        worker.id,
        'workflow step',
        {
          autoStartWorker: false,
          fromAgentId: `${workspace.id}:__workflow__`,
          workflowRunId: 'run-x',
        }
      )

      // 2. The agent-facing team list exposes the parked dispatch id + age —
      // and ONLY the orchestrator-owned one.
      const teamResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/team`, {
        headers: { 'x-hive-agent-id': orchestratorId, 'x-hive-agent-token': orchToken },
      })
      const team = (await teamResponse.json()) as TeamListItemPayload[]
      const alice = team.find((item) => item.name === 'Alice')
      expect(alice?.status).toBe('stopped')
      expect(alice?.open_dispatches).toEqual([
        expect.objectContaining({
          id: sent.dispatch_id,
          status: 'queued',
          task_preview: 'implement login',
        }),
      ])

      // 3. Starting the worker replays the parked dispatch into its stdin.
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })
      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        // The passive worker echoes injected stdin; the dispatch payload
        // carries the dispatch id and the task text.
        expect(run?.output).toContain(sent.dispatch_id)
        expect(run?.output).toContain('implement login')
      })
      const delivered = hive.store
        .listDispatches(workspace.id)
        .find((item) => item.id === sent.dispatch_id)
      expect(delivered?.status).toBe('submitted')
      expect(delivered?.submittedAt).not.toBeNull()
      // The workflow-owned dispatch was NOT replayed — still parked for its runner.
      const workflowAfter = hive.store
        .listDispatches(workspace.id)
        .find((item) => item.id === workflowDispatch.id)
      expect(workflowAfter?.status).toBe('queued')

      // 4. The worker can close the replayed dispatch with a normal report.
      hive.store.reportTask(workspace.id, worker.id, {
        text: 'done',
        dispatchId: sent.dispatch_id,
      })
      const closed = hive.store
        .listDispatches(workspace.id)
        .find((item) => item.id === sent.dispatch_id)
      expect(closed?.status).toBe('reported')
      // Only the workflow-owned dispatch remains open (its runner's business).
      expect(hive.store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(1)
    } finally {
      await hive.close()
    }
  }, 30_000)

  test('starting an interactive worker replays parked dispatches after startup input finishes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-queued-replay-post-start-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    writeSlowHermesCli(binDir)
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
    const passiveScript = join(workspacePath, 'passive.js')
    writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

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

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: process.execPath, args: [passiveScript] }),
      })
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: 'hermes' }),
      })
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })
      const orchToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token after start')

      const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: orchToken,
          to: 'Alice',
          text: 'manual replay task',
        }),
      })
      expect(sendResponse.status).toBe(202)
      const sent = (await sendResponse.json()) as { dispatch_id: string }

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })

      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        const output = run?.output ?? ''
        const startupIndex = output.indexOf('KIND:startup')
        const firstSubmitIndex = output.indexOf('SUBMITTED')
        const dispatchIndex = output.indexOf(`KIND:dispatch:${sent.dispatch_id}`)
        const dispatchSubmitIndex = output.indexOf('SUBMITTED', dispatchIndex)
        expect(output).toContain('<hive-message kind="startup">')
        expect(output).toContain('<hive-message kind="dispatch" from="@Orchestrator">')
        expect(output).toContain('manual replay task')
        expect(startupIndex).toBeGreaterThanOrEqual(0)
        expect(firstSubmitIndex).toBeGreaterThan(startupIndex)
        expect(dispatchIndex).toBeGreaterThan(firstSubmitIndex)
        expect(dispatchSubmitIndex).toBeGreaterThan(dispatchIndex)
      }, 8000)
      const delivered = hive.store
        .listDispatches(workspace.id)
        .find((item) => item.id === sent.dispatch_id)
      expect(delivered?.status).toBe('submitted')
      expect(delivered?.submittedAt).not.toBeNull()
    } finally {
      await hive.close()
    }
  }, 30_000)

  test('send to a running worker still waits for pending startup input readiness', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-running-post-start-race-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    writeSlowHermesCli(binDir, 2500)
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
    const passiveScript = join(workspacePath, 'passive.js')
    writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

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

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: process.execPath, args: [passiveScript] }),
      })
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: 'hermes' }),
      })
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })
      const orchToken = hive.store.peekAgentToken(orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token after start')

      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })
      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(run?.status).toBe('running')
        expect(run?.output).toContain('Hermes booting before prompt readiness')
        expect(run?.output).not.toContain('KIND:startup')
      }, 4000)

      const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: orchToken,
          to: 'Alice',
          text: 'gap send task',
        }),
      })
      expect(sendResponse.status).toBe(202)
      const sent = (await sendResponse.json()) as { dispatch_id: string }

      const duringStartup = hive.store
        .listDispatches(workspace.id)
        .find((item) => item.id === sent.dispatch_id)
      expect(duringStartup?.status).toBe('queued')
      expect(duringStartup?.submittedAt).toBeNull()

      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, worker.id)
        const output = run?.output ?? ''
        const startupIndex = output.indexOf('KIND:startup')
        const firstSubmitIndex = output.indexOf('SUBMITTED')
        const dispatchIndex = output.indexOf(`KIND:dispatch:${sent.dispatch_id}`)
        const dispatchSubmitIndex = output.indexOf('SUBMITTED', dispatchIndex)
        expect(output).toContain('gap send task')
        expect(startupIndex).toBeGreaterThanOrEqual(0)
        expect(firstSubmitIndex).toBeGreaterThan(startupIndex)
        expect(dispatchIndex).toBeGreaterThan(firstSubmitIndex)
        expect(dispatchSubmitIndex).toBeGreaterThan(dispatchIndex)
      }, 8000)

      const delivered = hive.store
        .listDispatches(workspace.id)
        .find((item) => item.id === sent.dispatch_id)
      expect(delivered?.status).toBe('submitted')
      expect(delivered?.submittedAt).not.toBeNull()
    } finally {
      await hive.close()
    }
  }, 30_000)

  test('dismissing a worker with a parked dispatch notifies the issuing orchestrator', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-queued-dismiss-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    const passiveScript = join(workspacePath, 'passive.js')
    writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)

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
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: process.execPath, args: [passiveScript] }),
      })
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })

      // Park a dispatch on the stopped worker, then remove the worker.
      const dispatch = await hive.store.dispatchTaskByWorkerName(
        workspace.id,
        'Alice',
        'doomed task',
        { autoStartWorker: false, fromAgentId: orchestratorId, hivePort: String(hive.port) }
      )
      await hive.store.deleteWorker(workspace.id, worker.id)

      // The issuer hears about the drop (live PTY injection; the passive
      // orchestrator echoes its stdin into the run output).
      await waitFor(() => {
        const run = hive.store.getActiveRunByAgentId(workspace.id, orchestratorId)
        expect(run?.output).toContain('DROPPED')
        expect(run?.output).toContain(dispatch.id)
      })
    } finally {
      await hive.close()
    }
  }, 30_000)
})
