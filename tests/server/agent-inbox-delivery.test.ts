import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildOrchestratorStatusPayload } from '../../src/server/agent-stdin-dispatcher.js'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { expandInboxReferences } from '../helpers/inbox.js'
import { startTestServer } from '../helpers/test-server.js'

const references = (text: string) => [
  ...text.matchAll(
    /\[hive-inbox [a-f0-9-]+[^\]\r\n]*\] Read ("(?:[^"\\]|\\.)*") for the complete Hive system message\./g
  ),
]

test('short system envelopes with control characters are file-backed without altering their content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-inbox-controls-'))
  const project = join(root, 'project')
  mkdirSync(project)
  const server = await startTestServer({ dataDir: join(root, 'data') })
  try {
    const workspace = server.store.createWorkspace(project, 'Controls')
    const orchestrator = `${workspace.id}:orchestrator`
    const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const received = join(root, 'received.txt')
    const script = join(root, 'receive.cjs')
    writeFileSync(received, '')
    writeFileSync(
      script,
      "const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.on('data',data=>fs.appendFileSync(process.argv[2],data));process.stdout.write('CONTROLS_RECEIVER_READY')"
    )
    for (const agent of [orchestrator, worker.id]) {
      server.store.configureAgentLaunch(workspace.id, agent, {
        command: process.execPath,
        args: [script, received],
      })
      await server.store.startAgent(workspace.id, agent, { hivePort: new URL(server.baseUrl).port })
      await expect
        .poll(() => server.store.getActiveRunByAgentId(workspace.id, agent)?.output)
        .toContain('CONTROLS_RECEIVER_READY')
    }
    const controls = ['\u0002', '\u0085', '\u2028', '\u2029']
    const text = `Marker ${controls.join(' preserved ')} end`
    const payload = buildOrchestratorStatusPayload(worker.name, text, [])
    expect(payload.length).toBeLessThanOrEqual(400)
    expect(payload).not.toMatch(/[\r\n]/)
    const response = await fetch(`${server.baseUrl}/api/team/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: worker.id,
        token: server.store.peekAgentToken(worker.id),
        result: text,
      }),
    })
    expect(response.status).toBe(202)
    const db = new Database(join(root, 'data', 'runtime.sqlite'), { readOnly: true })
    try {
      expect(
        db
          .prepare(
            'SELECT text FROM messages WHERE workspace_id = ? AND worker_id = ? AND type = ?'
          )
          .all(workspace.id, worker.id, 'status')
      ).toEqual([{ text }])
    } finally {
      db.close()
    }
    await expect.poll(() => readFileSync(received, 'utf8')).toMatch(/\r$/)
    const raw = readFileSync(received, 'utf8')
    const refs = references(raw)
    expect(refs).toHaveLength(1)
    for (const control of controls) expect(raw).not.toContain(control)
    const file = JSON.parse(refs[0]?.[1] ?? 'null') as string
    expect(readFileSync(file, 'utf8')).toBe(payload)
    expect(expandInboxReferences(raw)).toBe(`${payload}\r`)
  } finally {
    await server.close()
    removeTestPath(root)
  }
}, 20000)

test('long tasks use private inbox files and concurrent reports share one durable wakeup with actual byte metrics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-inbox-real-'))
  const project = join(root, 'project')
  mkdirSync(project)
  const server = await startTestServer({ dataDir: join(root, 'data') })
  try {
    const workspace = server.store.createWorkspace(project, 'Inbox')
    const orchestrator = `${workspace.id}:orchestrator`
    const script = join(root, 'receive.cjs')
    writeFileSync(
      script,
      "const fs=require('node:fs'); process.stdin.setRawMode(true); process.stdin.on('data',data=>fs.appendFileSync(process.argv[2],data)); process.stdout.write('INBOX_READY')"
    )
    const paths = new Map<string, string>()
    const workers = ['Alice', 'Bob', 'Carol'].map((name) =>
      server.store.addWorker(workspace.id, { name, role: 'coder' })
    )
    for (const [index, agent] of [orchestrator, ...workers.map((worker) => worker.id)].entries()) {
      const path = join(root, `received-${index}.txt`)
      paths.set(agent, path)
      writeFileSync(path, '')
      server.store.configureAgentLaunch(workspace.id, agent, {
        command: process.execPath,
        args: [script, path],
      })
      await server.store.startAgent(workspace.id, agent, { hivePort: new URL(server.baseUrl).port })
      await expect
        .poll(() => server.store.getActiveRunByAgentId(workspace.id, agent)?.output)
        .toContain('INBOX_READY')
    }
    const post = (command: string, actor: string, body: object) =>
      fetch(`${server.baseUrl}/api/team/${command}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: actor,
          token: server.store.peekAgentToken(actor),
          ...body,
        }),
      })
    const task = `Inspect Unicode 测试🙂 and preserve this large input.\n${'Details '.repeat(500)}`
    const dispatches: string[] = []
    for (const worker of workers) {
      const response = await post('send', orchestrator, { to: worker.name, text: task })
      expect(response.status).toBe(202)
      dispatches.push(((await response.json()) as { dispatch_id: string }).dispatch_id)
      await expect
        .poll(() => references(readFileSync(paths.get(worker.id) as string, 'utf8')).length)
        .toBe(1)
      const raw = readFileSync(paths.get(worker.id) as string, 'utf8')
      expect(raw).not.toContain('Details')
      expect(expandInboxReferences(raw)).toContain(task)
      const reference = references(raw)[0]
      expect(reference).toBeDefined()
      const file = JSON.parse(reference?.[1] as string) as string
      expect(file).toContain(join('data', 'inbox', workspace.id))
      if (process.platform !== 'win32') {
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(statSync(join(root, 'data', 'inbox', workspace.id)).mode & 0o777).toBe(0o700)
      }
      const id = dispatches.at(-1)
      await expect
        .poll(
          () =>
            server.store.listDispatches(workspace.id).find((row) => row.id === id)
              ?.dispatchPayloadBytes
        )
        .toBe(Buffer.byteLength(reference?.[0] as string))
    }
    const reports = await Promise.all(
      workers.map((worker, index) =>
        post('report', worker.id, {
          dispatch_id: dispatches[index],
          result: `REPORT_${index}\n${'Verified evidence '.repeat(100)}`,
          seen_seq: 0,
        })
      )
    )
    expect(reports.map((response) => response.status)).toEqual([202, 202, 202])
    const orchPath = paths.get(orchestrator) as string
    await expect.poll(() => references(readFileSync(orchPath, 'utf8')).length).toBe(1)
    await expect
      .poll(
        () =>
          server.store.listDispatches(workspace.id).filter((row) => row.reportPayloadBytes !== null)
            .length
      )
      .toBe(3)
    const raw = readFileSync(orchPath, 'utf8')
    const expanded = expandInboxReferences(raw)
    for (let index = 0; index < 3; index++)
      expect(expanded.match(new RegExp(`REPORT_${index}`, 'g'))).toHaveLength(1)
    const recorded = server.store
      .listDispatches(workspace.id)
      .reduce((sum, row) => sum + (row.reportPayloadBytes ?? 0), 0)
    expect(recorded).toBe(Buffer.byteLength(references(raw)[0]?.[0] as string))
    server.store.drainReportOutbox(workspace.id)
    const input = 'RAW_USER_INPUT\nsecond line'
    await server.store.deliverUserInput(workspace.id, orchestrator, input)
    await expect.poll(() => readFileSync(orchPath, 'utf8')).toContain(input)
    expect(references(readFileSync(orchPath, 'utf8'))).toHaveLength(1)
    await server.store.deleteWorkspace(workspace.id)
    expect(existsSync(join(root, 'data', 'inbox', workspace.id))).toBe(false)
    expect(existsSync(join(project, '.hive', 'PROTOCOL.md'))).toBe(false)
  } finally {
    await server.close()
    removeTestPath(root)
  }
}, 20000)

test('a report row replaced during the batching window cannot deliver its stale payload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-inbox-replace-'))
  const server = await startTestServer({ dataDir: root })
  try {
    const workspace = server.store.createWorkspace(root, 'Replace')
    const orchestrator = `${workspace.id}:orchestrator`
    const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const script = join(root, 'receive.cjs')
    const received = join(root, 'received.txt')
    writeFileSync(received, '')
    writeFileSync(
      script,
      "const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.on('data',data=>fs.appendFileSync(process.argv[2],data));process.stdout.write('REPLACE_READY')"
    )
    server.store.configureAgentLaunch(workspace.id, orchestrator, {
      command: process.execPath,
      args: [script, received],
    })
    await server.store.startAgent(workspace.id, orchestrator, {
      hivePort: new URL(server.baseUrl).port,
    })
    await expect
      .poll(() => server.store.getActiveRunByAgentId(workspace.id, orchestrator)?.output)
      .toContain('REPLACE_READY')
    const dispatch = await server.store.dispatchTask(
      workspace.id,
      worker.id,
      'Open responsibility',
      { fromAgentId: orchestrator, autoStartWorker: false }
    )
    const { default: Database } = await import('../../src/server/sqlite.js')
    const db = new Database(join(root, 'runtime.sqlite'))
    try {
      db.prepare(
        `INSERT INTO report_outbox (workspace_id,target_agent_id,dispatch_id,payload,created_at) VALUES (?,?,?,?,?)`
      ).run(workspace.id, orchestrator, dispatch.id, 'STALE_REPORT_MUST_NOT_DELIVER', Date.now())
      server.store.drainReportOutbox(workspace.id)
      server.store.deleteWorker(workspace.id, worker.id)
      await expect
        .poll(() => expandInboxReferences(readFileSync(received, 'utf8')))
        .toContain('DROPPED')
      const expanded = expandInboxReferences(readFileSync(received, 'utf8'))
      expect(expanded).toContain('DROPPED')
      expect(expanded).toContain(dispatch.id)
      expect(expanded).not.toContain('STALE_REPORT_MUST_NOT_DELIVER')
      await expect
        .poll(
          () =>
            (
              db
                .prepare('SELECT COUNT(*) AS n FROM report_outbox WHERE delivered_at IS NULL')
                .get() as { n: number }
            ).n
        )
        .toBe(0)
    } finally {
      db.close()
    }
  } finally {
    await server.close()
    removeTestPath(root)
  }
}, 10000)

test('short single-line dispatches, questions, reports, cancels, and user inputs deliver inline with zero inbox files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-inbox-inline-'))
  const project = join(root, 'project')
  mkdirSync(project)
  const server = await startTestServer({ dataDir: join(root, 'data') })
  try {
    const workspace = server.store.createWorkspace(project, 'Inline')
    const orchestrator = `${workspace.id}:orchestrator`
    const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const script = join(root, 'receive.cjs')
    writeFileSync(
      script,
      "const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.on('data',data=>fs.appendFileSync(process.argv[2],data));process.stdout.write('INLINE_READY')"
    )
    const orchReceived = join(root, 'orch.txt')
    const workerReceived = join(root, 'worker.txt')
    writeFileSync(orchReceived, '')
    writeFileSync(workerReceived, '')
    for (const [agent, file] of [
      [orchestrator, orchReceived],
      [worker.id, workerReceived],
    ] as const) {
      server.store.configureAgentLaunch(workspace.id, agent, {
        command: process.execPath,
        args: [script, file],
      })
      await server.store.startAgent(workspace.id, agent, { hivePort: new URL(server.baseUrl).port })
      await expect
        .poll(() => server.store.getActiveRunByAgentId(workspace.id, agent)?.output)
        .toContain('INLINE_READY')
    }
    const post = (command: string, actor: string, body: object) =>
      fetch(`${server.baseUrl}/api/team/${command}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: actor,
          token: server.store.peekAgentToken(actor),
          ...body,
        }),
      })

    const sendRes = await post('send', orchestrator, { to: 'Alice', text: '把按钮改成蓝色' })
    expect(sendRes.status).toBe(202)
    const { dispatch_id: dispatchId } = (await sendRes.json()) as { dispatch_id: string }
    await expect.poll(() => readFileSync(workerReceived, 'utf8')).toContain('把按钮改成蓝色')
    expect(references(readFileSync(workerReceived, 'utf8'))).toHaveLength(0)

    const askRes = await post('ask', worker.id, {
      dispatch_id: dispatchId,
      text: '保留旧按钮样式名吗？',
    })
    expect(askRes.status).toBe(202)
    await expect.poll(() => readFileSync(orchReceived, 'utf8')).toContain('保留旧按钮样式名吗？')
    expect(references(readFileSync(orchReceived, 'utf8'))).toHaveLength(0)

    const reportRes = await post('report', worker.id, {
      dispatch_id: dispatchId,
      result: '已改为蓝色并通过检查',
    })
    expect(reportRes.status).toBe(202)
    await expect.poll(() => readFileSync(orchReceived, 'utf8')).toContain('已改为蓝色并通过检查')
    expect(references(readFileSync(orchReceived, 'utf8'))).toHaveLength(0)

    const send2Res = await post('send', orchestrator, { to: 'Alice', text: '再改一下图标' })
    const { dispatch_id: dispatch2Id } = (await send2Res.json()) as { dispatch_id: string }
    await expect.poll(() => readFileSync(workerReceived, 'utf8')).toContain('再改一下图标')
    const cancelRes = await post('cancel', orchestrator, {
      dispatch_id: dispatch2Id,
      reason: '产品取消了图标改动',
    })
    expect(cancelRes.status).toBe(202)
    await expect.poll(() => readFileSync(workerReceived, 'utf8')).toContain('产品取消了图标改动')
    expect(references(readFileSync(workerReceived, 'utf8'))).toHaveLength(0)

    await server.store.deliverUserInput(workspace.id, orchestrator, '帮我总结一下')
    await expect.poll(() => readFileSync(orchReceived, 'utf8')).toContain('帮我总结一下')
    expect(readFileSync(orchReceived, 'utf8')).not.toContain('please draft')
    // User input itself does not inject a reminder block: only the earlier inline report carried one.
    expect(readFileSync(orchReceived, 'utf8').endsWith('帮我总结一下\r')).toBe(true)
    expect(existsSync(join(root, 'data', 'inbox', workspace.id))).toBe(false)
  } finally {
    await server.close()
    removeTestPath(root)
  }
}, 20000)
