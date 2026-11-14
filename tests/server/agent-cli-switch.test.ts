import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

const fixture = async () => {
  const previous = process.env.HIVE_DATA_DIR
  const root = mkdtempSync(join(tmpdir(), 'hive-agent-switch-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath)
  const receiver = join(root, 'receiver.cjs')
  const receivedLog = join(root, 'received.jsonl')
  writeFileSync(receivedLog, '')
  writeFileSync(
    receiver,
    `const { readFileSync, appendFileSync } = require('node:fs')
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let input = ''
const record = (text) => {
  appendFileSync(${JSON.stringify(receivedLog)}, JSON.stringify({agentId:process.env.HIVE_AGENT_ID,text}) + '\\n')
  process.stdout.write('RECEIVED_BEGIN\\r\\n' + text + '\\r\\nRECEIVED_END\\r\\n')
}
process.stdin.on('data', chunk => {
  input += chunk
  const parts = input.split(/[\\r\\n]+/)
  input = parts.pop() || ''
  for (const line of parts) {
    const inboxMatch = line.match(/Read ("[^"\\r\\n]+") for the complete Hive system message/)
    if (inboxMatch) {
      record(readFileSync(JSON.parse(inboxMatch[1]), 'utf8'))
      continue
    }
    const inlineMatch = line.match(/<hive-message\\b[\\s\\S]*<\\/hive-(?:system-reminder|message)>/)
    if (inlineMatch) record(inlineMatch[0])
  }
})
process.stdout.write('SWITCH_RECEIVER_READY\\r\\n')`
  )
  process.env.HIVE_DATA_DIR = root
  const hive = await runHiveCommand(['--port', '0'])
  const workspace = hive.store.createWorkspace(workspacePath, 'Switch')
  const cookie = await getUiCookie(`http://127.0.0.1:${hive.port}`)
  const switchAgent = (agentId: string, body: object, authorized = true) =>
    fetch(
      `http://127.0.0.1:${hive.port}/api/ui/workspaces/${workspace.id}/agents/${encodeURIComponent(agentId)}/switch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authorized ? { cookie } : {}) },
        body: JSON.stringify(body),
      }
    )
  const command = (script: string) =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
  return {
    root,
    hive,
    workspace,
    receiver,
    received: (agentId: string) =>
      readFileSync(receivedLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { agentId: string; text: string })
        .filter((entry) => entry.agentId === agentId)
        .map((entry) => entry.text),
    switchAgent,
    command,
    close: async () => {
      await hive.close()
      if (previous === undefined) delete process.env.HIVE_DATA_DIR
      else process.env.HIVE_DATA_DIR = previous
      removeTestPath(root)
    },
  }
}

test('controlled orchestrator switch waits for old exit and preserves ephemeral members and pending work', async () => {
  const f = await fixture()
  try {
    const id = `${f.workspace.id}:orchestrator`
    f.hive.store.configureAgentLaunch(f.workspace.id, id, {
      command: process.execPath,
      args: [f.receiver],
    })
    const old = await f.hive.store.startAgent(f.workspace.id, id, { hivePort: String(f.hive.port) })
    await expect
      .poll(() => f.hive.store.getLiveRun(old.runId).output)
      .toContain('SWITCH_RECEIVER_READY')
    const child = f.hive.store.addWorker(f.workspace.id, {
      name: 'Temporary',
      role: 'coder',
      ephemeral: true,
      spawnedBy: 'orchestrator',
    })
    const dispatch = await f.hive.store.dispatchTask(
      f.workspace.id,
      child.id,
      'Keep this responsibility'
    )
    expect(
      (await f.switchAgent(id, { startup_command: f.command(f.receiver), restart: true }, false))
        .status
    ).toBe(403)
    const response = await f.switchAgent(id, {
      startup_command: f.command(f.receiver),
      restart: true,
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const switched = (await response.json()) as { run_id: string }
    expect(switched.run_id).not.toBe(old.runId)
    expect(f.hive.store.listAgentRuns(id).find((run) => run.runId === old.runId)?.status).toBe(
      'exited'
    )
    expect(f.hive.store.getActiveRunByAgentId(f.workspace.id, id)?.runId).toBe(switched.run_id)
    expect(f.hive.store.getAgent(f.workspace.id, child.id).ephemeral).toBe(true)
    expect(f.hive.store.getDispatch(f.workspace.id, dispatch.id)?.status).toBe('queued')
  } finally {
    await f.close()
  }
}, 20000)

test('switching a stopped worker replays its queued dispatch exactly once and drains its buffered report to the switched orchestrator', async () => {
  const f = await fixture()
  try {
    const orch = `${f.workspace.id}:orchestrator`
    const worker = f.hive.store.addWorker(f.workspace.id, { name: 'Queued', role: 'coder' })
    f.hive.store.configureAgentLaunch(f.workspace.id, worker.id, {
      command: process.execPath,
      args: [f.receiver],
    })
    const dispatch = await f.hive.store.dispatchTask(
      f.workspace.id,
      worker.id,
      'queued-switch-task'
    )
    const response = await f.switchAgent(worker.id, {
      startup_command: f.command(f.receiver),
      restart: true,
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const { run_id: runId } = (await response.json()) as { run_id: string }
    await expect
      .poll(() => f.hive.store.getDispatch(f.workspace.id, dispatch.id)?.deliveredAt)
      .toEqual(expect.any(Number))
    const taskEnvelopes = () =>
      f
        .received(worker.id)
        .filter(
          (text) =>
            text.startsWith('<hive-message kind="dispatch"') &&
            text.includes(`dispatch_id: ${dispatch.id}`)
        )
    await expect.poll(() => taskEnvelopes()).toHaveLength(1)
    expect(taskEnvelopes()[0]).toContain('queued-switch-task')
    expect(f.hive.store.getActiveRunByAgentId(f.workspace.id, worker.id)?.runId).toBe(runId)
    f.hive.store.reportTask(f.workspace.id, worker.id, {
      dispatchId: dispatch.id,
      text: 'buffered-report-after-switch',
      requireActiveRun: true,
    })
    const orchResponse = await f.switchAgent(orch, {
      startup_command: f.command(f.receiver),
      restart: true,
    })
    expect(orchResponse.status, await orchResponse.clone().text()).toBe(200)
    const { run_id: orchRunId } = (await orchResponse.json()) as { run_id: string }
    await expect
      .poll(() =>
        f
          .received(orch)
          .filter(
            (text) =>
              text.startsWith('<hive-message kind="report"') &&
              text.includes('buffered-report-after-switch')
          )
      )
      .toHaveLength(1)
    expect(f.hive.store.getActiveRunByAgentId(f.workspace.id, orch)?.runId).toBe(orchRunId)
    expect(f.hive.store.getDispatch(f.workspace.id, dispatch.id)?.status).toBe('reported')
  } finally {
    await f.close()
  }
}, 25000)

test.each([
  0, 1,
])('failed early exit %s preserves temporary members and permits a clean retry', async (exitCode) => {
  const f = await fixture()
  try {
    const orch = `${f.workspace.id}:orchestrator`
    const child = f.hive.store.addWorker(f.workspace.id, {
      name: 'Keep',
      role: 'coder',
      ephemeral: true,
      spawnedBy: 'orchestrator',
    })
    const exit = join(f.root, `exit-${exitCode}.cjs`)
    writeFileSync(exit, `process.stdout.write('EARLY_EXIT_BANNER');process.exit(${exitCode})`)
    const failed = await f.switchAgent(orch, { startup_command: f.command(exit), restart: true })
    expect(failed.status, await failed.clone().text()).toBe(409)
    expect(f.hive.store.getAgent(f.workspace.id, orch).status).toBe('stopped')
    expect(f.hive.store.getAgent(f.workspace.id, child.id).ephemeral).toBe(true)
    const retry = await f.switchAgent(orch, {
      startup_command: f.command(f.receiver),
      restart: true,
    })
    expect(retry.status, await retry.clone().text()).toBe(200)
    expect(f.hive.store.getAgent(f.workspace.id, child.id).ephemeral).toBe(true)
  } finally {
    await f.close()
  }
}, 20000)

test('a silent healthy command is accepted while competing switches, starts, config writes and auto-send are rejected', async () => {
  const f = await fixture()
  try {
    const worker = f.hive.store.addWorker(f.workspace.id, { name: 'Silent', role: 'coder' })
    const silent = join(f.root, 'silent.cjs')
    const workerCwd = join(f.root, 'member-cwd')
    const cwdEvidence = join(f.root, 'cwd.txt')
    mkdirSync(workerCwd)
    f.hive.store.configureAgentLaunch(f.workspace.id, worker.id, {
      command: process.execPath,
      args: [f.receiver],
      cwd: workerCwd,
    })
    writeFileSync(
      silent,
      `require('node:fs').writeFileSync(${JSON.stringify(cwdEvidence)}, process.cwd());process.stdin.resume()`
    )
    const pending = f.switchAgent(worker.id, { startup_command: f.command(silent), restart: true })
    await expect
      .poll(() => f.hive.store.peekAgentLaunchConfig(f.workspace.id, worker.id)?.args?.at(-1))
      .toContain(silent)
    expect(
      (await f.switchAgent(worker.id, { startup_command: f.command(f.receiver), restart: false }))
        .status
    ).toBe(409)
    await expect(
      f.hive.store.startAgent(f.workspace.id, worker.id, { hivePort: String(f.hive.port) })
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(() =>
      f.hive.store.configureAgentLaunch(f.workspace.id, worker.id, {
        command: process.execPath,
        args: [f.receiver],
      })
    ).toThrow()
    await expect(
      f.hive.store.dispatchTaskByWorkerName(f.workspace.id, worker.name, 'must-not-race', {
        fromAgentId: `${f.workspace.id}:orchestrator`,
        hivePort: String(f.hive.port),
      })
    ).rejects.toMatchObject({ statusCode: 409 })
    const response = await pending
    expect(response.status, await response.clone().text()).toBe(200)
    const { run_id: runId } = (await response.json()) as { run_id: string }
    expect(f.hive.store.getActiveRunByAgentId(f.workspace.id, worker.id)?.runId).toBe(runId)
    expect(f.hive.store.listDispatches(f.workspace.id)).toEqual([])
    expect(realpathSync(readFileSync(cwdEvidence, 'utf8'))).toBe(realpathSync(workerCwd))
    expect(f.hive.store.peekAgentLaunchConfig(f.workspace.id, worker.id)?.cwd).toBe(workerCwd)
    const stopped = await f.switchAgent(worker.id, {
      startup_command: f.command(f.receiver),
      restart: false,
    })
    expect(await stopped.json()).toEqual({ run_id: null })
    expect(f.hive.store.getActiveRunByAgentId(f.workspace.id, worker.id)).toBeUndefined()
  } finally {
    await f.close()
  }
}, 20000)

test.skipIf(process.platform === 'win32')(
  'switch waits for an already-stopping old PTY before spawning its replacement',
  async () => {
    const f = await fixture()
    try {
      const id = `${f.workspace.id}:orchestrator`
      const order = join(f.root, 'exit-order.txt')
      writeFileSync(order, '')
      const oldScript = join(f.root, 'slow-exit.cjs')
      writeFileSync(
        oldScript,
        `
const {appendFileSync} = require('node:fs')
let stopping = false
process.on('SIGTERM', () => {
  if (stopping) return
  stopping = true
  setTimeout(() => { appendFileSync(${JSON.stringify(order)}, 'old-exit\\n'); process.exit(0) }, 250)
})
process.stdout.write('OLD_READY')
process.stdin.resume()
`
      )
      const nextScript = join(f.root, 'new-start.cjs')
      writeFileSync(
        nextScript,
        `require('node:fs').appendFileSync(${JSON.stringify(order)}, 'new-start\\n');process.stdout.write('NEW_READY');process.stdin.resume()`
      )
      f.hive.store.configureAgentLaunch(f.workspace.id, id, {
        command: process.execPath,
        args: [oldScript],
      })
      const old = await f.hive.store.startAgent(f.workspace.id, id, {
        hivePort: String(f.hive.port),
      })
      await expect.poll(() => f.hive.store.getLiveRun(old.runId).output).toContain('OLD_READY')
      f.hive.store.stopAgentRun(old.runId)
      const response = await f.switchAgent(id, {
        startup_command: f.command(nextScript),
        restart: true,
      })
      expect(response.status, await response.clone().text()).toBe(200)
      expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual(['old-exit', 'new-start'])
    } finally {
      await f.close()
    }
  },
  15000
)

test('an ephemeral worker keeps its submitted dispatch through a planned switch and a failed replacement, while workflow members reject switching', async () => {
  const f = await fixture()
  try {
    const worker = f.hive.store.addWorker(f.workspace.id, {
      name: 'TemporaryWorker',
      role: 'coder',
      ephemeral: true,
      spawnedBy: 'orchestrator',
    })
    f.hive.store.configureAgentLaunch(f.workspace.id, worker.id, {
      command: process.execPath,
      args: [f.receiver],
    })
    await f.hive.store.startAgent(f.workspace.id, worker.id, { hivePort: String(f.hive.port) })
    const dispatch = await f.hive.store.dispatchTaskByWorkerName(
      f.workspace.id,
      worker.name,
      'Preserve active responsibility',
      { fromAgentId: `${f.workspace.id}:orchestrator`, hivePort: String(f.hive.port) }
    )
    await expect
      .poll(() => f.hive.store.getDispatch(f.workspace.id, dispatch.id)?.deliveredAt)
      .toEqual(expect.any(Number))
    const failedScript = join(f.root, 'ephemeral-fail.cjs')
    writeFileSync(failedScript, 'process.exit(1)')
    const failed = await f.switchAgent(worker.id, {
      startup_command: f.command(failedScript),
      restart: true,
    })
    expect(failed.status, await failed.clone().text()).toBe(409)
    expect(f.hive.store.getAgent(f.workspace.id, worker.id)).toMatchObject({
      ephemeral: true,
      pendingTaskCount: 1,
      status: 'stopped',
    })
    expect(f.hive.store.getDispatch(f.workspace.id, dispatch.id)?.status).toBe('submitted')
    const retry = await f.switchAgent(worker.id, {
      startup_command: f.command(f.receiver),
      restart: true,
    })
    expect(retry.status, await retry.clone().text()).toBe(200)
    expect(f.hive.store.getAgent(f.workspace.id, worker.id)).toMatchObject({
      ephemeral: true,
      pendingTaskCount: 1,
      status: 'working',
    })
    expect(f.hive.store.getDispatch(f.workspace.id, dispatch.id)?.status).toBe('submitted')
    const workflowWorker = f.hive.store.addWorker(f.workspace.id, {
      name: 'WorkflowOwned',
      role: 'coder',
      ephemeral: true,
      spawnedBy: 'workflow',
    })
    expect(
      (
        await f.switchAgent(workflowWorker.id, {
          startup_command: f.command(f.receiver),
          restart: true,
        })
      ).status
    ).toBe(409)
    expect(f.hive.store.peekAgentLaunchConfig(f.workspace.id, workflowWorker.id)).toBeUndefined()
  } finally {
    await f.close()
  }
}, 20000)
