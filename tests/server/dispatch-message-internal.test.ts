import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

const originalDataDir = process.env.HIVE_DATA_DIR
const directories: string[] = []
afterEach(() => {
  if (originalDataDir === undefined) delete process.env.HIVE_DATA_DIR
  else process.env.HIVE_DATA_DIR = originalDataDir
  for (const directory of directories.splice(0)) removeTestPath(directory)
})

test('internal PTYs exchange questions and answers while preserving permissions, seen barrier and retirement', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-internal-messages-'))
  directories.push(dataDir)
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath)
  const script = join(dataDir, 'receive.cjs')
  writeFileSync(
    script,
    [
      "const { appendFileSync } = require('node:fs')",
      'process.stdin.setRawMode(true)',
      "process.stdin.on('data', chunk => appendFileSync(process.argv[2], chunk))",
      "process.stdout.write('MESSAGE_RECEIVER_READY\\r\\n')",
    ].join('\n')
  )
  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  try {
    const baseUrl = `http://127.0.0.1:${hive.port}`
    const cookie = await getUiCookie(baseUrl)
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'Internal',
        path: workspacePath,
        autostart_orchestrator: false,
      }),
    })
    expect(response.status).toBe(201)
    const workspace = (await response.json()) as { id: string }
    const orchestratorId = `${workspace.id}:orchestrator`
    const worker = hive.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const outsider = hive.store.addWorker(workspace.id, { name: 'Bob', role: 'reviewer' })
    const receivedFiles = new Map<string, string>()
    for (const [index, agentId] of [orchestratorId, worker.id, outsider.id].entries()) {
      const received = join(dataDir, `received-${index}.txt`)
      receivedFiles.set(agentId, received)
      writeFileSync(received, '')
      hive.store.configureAgentLaunch(workspace.id, agentId, {
        command: process.execPath,
        args: [script, received],
      })
      await hive.store.startAgent(workspace.id, agentId, { hivePort: String(hive.port) })
      await expect
        .poll(() => hive.store.getActiveRunByAgentId(workspace.id, agentId)?.output)
        .toContain('MESSAGE_RECEIVER_READY')
    }
    const post = (path: string, agentId: string, body: Record<string, unknown>) =>
      fetch(`${baseUrl}/api/team/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: agentId,
          token: hive.store.peekAgentToken(agentId),
          ...body,
        }),
      })
    const dispatch = await hive.store.dispatchTaskByWorkerName(
      workspace.id,
      'Alice',
      'Investigate',
      {
        fromAgentId: orchestratorId,
      }
    )
    const questionResponse = await post('message', worker.id, {
      dispatch_id: dispatch.id,
      recipient: 'orchestrator',
      kind: 'question',
      text: 'Which branch should I use?',
    })
    expect(questionResponse.status).toBe(202)
    const { message: question } = (await questionResponse.json()) as { message: { id: string } }
    await expect
      .poll(() => readFileSync(receivedFiles.get(orchestratorId) as string, 'utf8'))
      .toContain('Which branch should I use?')
    expect(
      (await post('reply', outsider.id, { question_id: question.id, text: 'Wrong owner' })).status
    ).toBe(403)
    const answerResponse = await post('reply', orchestratorId, {
      question_id: question.id,
      text: 'Use main.',
    })
    expect(answerResponse.status).toBe(202)
    const { message: answer } = (await answerResponse.json()) as { message: { sequence: number } }
    await expect
      .poll(() => readFileSync(receivedFiles.get(worker.id) as string, 'utf8'))
      .toContain('Use main.')
    const questionState = await post('question', worker.id, { question_id: question.id })
    expect(await questionState.json()).toMatchObject({
      status: 'answered',
      answers: [{ text: 'Use main.' }],
    })
    const staleReport = await post('report', worker.id, {
      dispatch_id: dispatch.id,
      result: 'Done',
      seen_seq: 0,
    })
    expect(staleReport.status).toBe(409)
    expect(
      hive.store.listDispatches(workspace.id).find((row) => row.id === dispatch.id)?.status
    ).toBe('submitted')
    const report = await post('report', worker.id, {
      dispatch_id: dispatch.id,
      result: 'Done',
      seen_seq: answer.sequence,
    })
    expect(report.status).toBe(202)
    await expect
      .poll(() => readFileSync(receivedFiles.get(orchestratorId) as string, 'utf8'))
      .toContain('Done')
    expect(
      hive.store.listDispatches(workspace.id).find((row) => row.id === dispatch.id)?.status
    ).toBe('reported')

    for (const retirement of ['cancel', 'delete'] as const) {
      const next = await hive.store.dispatchTaskByWorkerName(workspace.id, 'Alice', retirement, {
        fromAgentId: orchestratorId,
      })
      const pendingResponse = await post('message', worker.id, {
        dispatch_id: next.id,
        recipient: 'orchestrator',
        kind: 'question',
        text: `Pending ${retirement}?`,
      })
      expect(pendingResponse.status).toBe(202)
      const { message: pending } = (await pendingResponse.json()) as { message: { id: string } }
      if (retirement === 'cancel') {
        expect(
          (await post('cancel', orchestratorId, { dispatch_id: next.id, reason: 'Superseded' }))
            .status
        ).toBe(202)
      } else hive.store.deleteWorker(workspace.id, worker.id)
      const state = await post('question', orchestratorId, { question_id: pending.id })
      expect(await state.json()).toMatchObject({ status: 'closed', answers: [] })
      expect(
        (await post('reply', orchestratorId, { question_id: pending.id, text: 'Too late' })).status
      ).toBe(409)
    }
  } finally {
    await hive.close()
  }
}, 30000)
