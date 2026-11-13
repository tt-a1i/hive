import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

test.each([
  { ephemeral: false, stop: 'crash' },
  { ephemeral: true, stop: 'crash' },
  { ephemeral: false, stop: 'manual' },
  { ephemeral: false, stop: 'shutdown' },
])('exit handling for ephemeral=$ephemeral, stop=$stop', async ({ ephemeral, stop }) => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-unexpected-exit-'))
  const previous = process.env.HIVE_DATA_DIR
  process.env.HIVE_DATA_DIR = dir
  const project = join(dir, 'project')
  mkdirSync(project)
  const marker = join(dir, 'exit-now')
  const output = join(dir, 'received')
  const workerScript = join(dir, 'worker.cjs')
  const orchScript = join(dir, 'orchestrator.cjs')
  writeFileSync(
    workerScript,
    `const fs=require('node:fs'); process.stdin.resume(); process.stdout.write('WORKER_READY'); setInterval(()=>{if(fs.existsSync(process.argv[2])) process.exit(7)},20)`
  )
  writeFileSync(
    orchScript,
    `const fs=require('node:fs'); process.stdin.setRawMode(true); process.stdin.on('data',x=>fs.appendFileSync(process.argv[2],x)); process.stdout.write('ORCH_READY')`
  )
  writeFileSync(output, '')
  const hive = await runHiveCommand(['--port', '0'])
  try {
    const base = `http://127.0.0.1:${hive.port}`
    const cookie = await getUiCookie(base)
    const created = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Exit', path: project, autostart_orchestrator: false }),
    })
    expect(created.status).toBe(201)
    const workspace = (await created.json()) as { id: string }
    const orch = `${workspace.id}:orchestrator`
    const worker = hive.store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
      ephemeral,
      spawnedBy: 'orchestrator',
    })
    hive.store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript, marker],
    })
    const run = await hive.store.startAgent(workspace.id, worker.id, {
      hivePort: String(hive.port),
    })
    await expect
      .poll(() => hive.store.getActiveRunByAgentId(workspace.id, worker.id)?.output)
      .toContain('WORKER_READY')
    const dispatch = await hive.store.dispatchTaskByWorkerName(
      workspace.id,
      'Alice',
      'Investigate',
      { fromAgentId: orch }
    )
    if (stop === 'shutdown') await hive.store.close()
    else if (stop === 'manual') hive.store.stopAgentRun(run.runId)
    else writeFileSync(marker, 'exit')
    if (stop !== 'crash') {
      if (stop === 'manual')
        await expect
          .poll(
            () =>
              hive.store.listAgentRuns(worker.id).find((item) => item.runId === run.runId)?.status
          )
          .toBe('exited')
      const db = new Database(join(dir, 'runtime.sqlite'))
      try {
        expect(
          db.prepare('SELECT payload FROM report_outbox WHERE workspace_id = ?').all(workspace.id)
        ).toEqual([])
        expect(db.prepare('SELECT status FROM dispatches WHERE id = ?').get(dispatch.id)).toEqual({
          status: 'submitted',
        })
      } finally {
        db.close()
      }
      return
    }
    await expect
      .poll(() => hive.store.getActiveRunByAgentId(workspace.id, worker.id))
      .toBeUndefined()
    if (ephemeral) {
      await expect.poll(() => hive.store.listWorkers(workspace.id)).toEqual([])
      expect(hive.store.getDispatch(workspace.id, dispatch.id)?.status).toBe('cancelled')
    } else {
      expect(hive.store.getWorker(workspace.id, worker.id).status).toBe('stopped')
      expect(hive.store.getDispatch(workspace.id, dispatch.id)?.status).toBe('submitted')
    }
    const db = new Database(join(dir, 'runtime.sqlite'))
    try {
      const pending = db
        .prepare(
          'SELECT payload FROM report_outbox WHERE workspace_id = ? AND delivered_at IS NULL'
        )
        .all(workspace.id) as Array<{ payload: string }>
      expect(pending).toHaveLength(1)
      expect(pending[0]?.payload).toContain('exited before reporting')
      expect(pending[0]?.payload).toContain('exit code 7')
      expect(pending[0]?.payload).toContain(run.runId)
    } finally {
      db.close()
    }
    hive.store.configureAgentLaunch(workspace.id, orch, {
      command: process.execPath,
      args: [orchScript, output],
    })
    await hive.store.startAgent(workspace.id, orch, { hivePort: String(hive.port) })
    const delivered = () => {
      const text = readFileSync(output, 'utf8')
      const pointer = /Read ("[^"]+")/.exec(text)?.[1]
      return pointer ? readFileSync(JSON.parse(pointer) as string, 'utf8') : text
    }
    await expect.poll(delivered).toContain('exited before reporting')
    expect(delivered()).toContain(dispatch.id)
  } finally {
    await hive.close()
    if (previous === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = previous
    removeTestPath(dir)
  }
}, 20000)
