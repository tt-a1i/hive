import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  writeFileSync(
    receiver,
    `const { readFileSync } = require('node:fs')
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let input = ''
process.stdin.on('data', chunk => {
  input += chunk
  const file = input.match(/Read ("[^"\\r\\n]+") for the complete Hive system message/)
  if (!file) return
  const text = readFileSync(JSON.parse(file[1]), 'utf8')
  process.stdout.write('RECEIVED_BEGIN\\r\\n' + text + '\\r\\nRECEIVED_END\\r\\n')
  input = ''
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
    await expect.poll(() => f.hive.store.getLiveRun(runId).output).toContain('queued-switch-task')
    const output = f.hive.store.getLiveRun(runId).output
    expect(output.split('<hive-message kind="dispatch"').length - 1).toBe(1)
    f.hive.store.reportTask(f.workspace.id, worker.id, {
      dispatchId: dispatch.id,
      text: 'buffered-report-after-switch',
    })
    const orchResponse = await f.switchAgent(orch, {
      startup_command: f.command(f.receiver),
      restart: true,
    })
    expect(orchResponse.status, await orchResponse.clone().text()).toBe(200)
    const { run_id: orchRunId } = (await orchResponse.json()) as { run_id: string }
    await expect
      .poll(() => f.hive.store.getLiveRun(orchRunId).output)
      .toContain('buffered-report-after-switch')
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
    writeFileSync(silent, 'process.stdin.resume()')
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
