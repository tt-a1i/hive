import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { expandInboxReferences } from '../helpers/inbox.js'
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
        .poll(() => hive.store.getActiveRunByAgentId(workspace.id, agentId)?.output, {
          timeout: 10000,
        })
        .toContain('MESSAGE_RECEIVER_READY')
    }
    const post = (
      path: string,
      agentId: string,
      body: Record<string, unknown>,
      signal?: AbortSignal
    ) =>
      fetch(`${baseUrl}/api/team/${path}`, {
        method: 'POST',
        ...(signal ? { signal } : {}),
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
    const questionResponse = await post('ask', worker.id, {
      text: 'Which branch should I use?',
    })
    expect(questionResponse.status).toBe(202)
    const { message: question } = (await questionResponse.json()) as { message: { id: string } }
    await expect
      .poll(() =>
        expandInboxReferences(readFileSync(receivedFiles.get(orchestratorId) as string, 'utf8'))
      )
      .toContain('Which branch should I use?')
    expect(
      (await post('reply', outsider.id, { question_id: question.id, text: 'Wrong owner' })).status
    ).toBe(403)
    expect((await post('ask', outsider.id, { text: 'No assignment' })).status).toBe(409)
    expect((await post('ask', worker.id, { dispatch_id: 'missing', text: 'Invalid' })).status).toBe(
      409
    )
    expect(
      (await post('question', worker.id, { question_id: question.id, wait_ms: 60001 })).status
    ).toBe(400)
    const waiting = post('question', worker.id, { question_id: question.id, wait_ms: 5000 })
    const uiReply = (cookie = '') =>
      fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/questions/${question.id}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ text: 'Use main.' }),
      })
    expect((await uiReply()).status).toBe(403)
    const answerResponse = await uiReply(cookie)
    expect((await uiReply(cookie)).status).toBe(409)
    expect(answerResponse.status).toBe(202)
    expect(await (await waiting).json()).toMatchObject({
      status: 'answered',
      answers: [{ text: 'Use main.' }],
    })
    const { message: answer } = (await answerResponse.json()) as { message: { sequence: number } }
    await expect
      .poll(() =>
        expandInboxReferences(readFileSync(receivedFiles.get(worker.id) as string, 'utf8'))
      )
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
      .poll(() =>
        expandInboxReferences(readFileSync(receivedFiles.get(orchestratorId) as string, 'utf8'))
      )
      .toContain('Done')
    expect(
      hive.store.listDispatches(workspace.id).find((row) => row.id === dispatch.id)?.status
    ).toBe('reported')

    const followUp = await post('ask', orchestratorId, {
      dispatch_id: dispatch.id,
      text: 'What changed?',
    })
    expect(followUp.status).toBe(202)
    const { message: followUpQuestion } = (await followUp.json()) as { message: { id: string } }
    const followUpWait = post('question', orchestratorId, {
      question_id: followUpQuestion.id,
      wait_ms: 5000,
    })
    expect(
      (
        await post('reply', worker.id, {
          question_id: followUpQuestion.id,
          text: 'The parser changed.',
        })
      ).status
    ).toBe(202)
    expect(await (await followUpWait).json()).toMatchObject({
      status: 'answered',
      answers: [{ text: 'The parser changed.' }],
    })

    // Two open assignments must never guess which responsibility owns a question.
    const extra = await hive.store.dispatchTaskByWorkerName(workspace.id, 'Alice', 'Second task', {
      fromAgentId: orchestratorId,
    })
    const extra2 = await hive.store.dispatchTaskByWorkerName(workspace.id, 'Alice', 'Third task', {
      fromAgentId: orchestratorId,
    })
    const beforeQuestions = hive.store.listSentDispatchQuestions(workspace.id, worker.id).questions
      .length
    expect((await post('ask', worker.id, { text: 'Ambiguous question' })).status).toBe(409)
    expect(hive.store.listSentDispatchQuestions(workspace.id, worker.id).questions).toHaveLength(
      beforeQuestions
    )
    await hive.store.cancelTask(workspace.id, extra.id, {
      fromAgentId: orchestratorId,
      reason: 'Done',
    })
    await hive.store.cancelTask(workspace.id, extra2.id, {
      fromAgentId: orchestratorId,
      reason: 'Done',
    })

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
      const pendingWait = post('question', orchestratorId, {
        question_id: pending.id,
        wait_ms: 5000,
      })
      if (retirement === 'cancel') {
        expect(
          (await post('cancel', orchestratorId, { dispatch_id: next.id, reason: 'Superseded' }))
            .status
        ).toBe(202)
      } else hive.store.deleteWorker(workspace.id, worker.id)
      expect(await (await pendingWait).json()).toMatchObject({ status: 'closed' })
      const state = await post('question', orchestratorId, { question_id: pending.id })
      expect(await state.json()).toMatchObject({ status: 'closed', answers: [] })
      expect(
        (await post('reply', orchestratorId, { question_id: pending.id, text: 'Too late' })).status
      ).toBe(409)
    }
    // Observe actual subscription and cleanup, while retaining the real implementation.
    const subscribe = hive.store.subscribeDispatchQuestionChanges
    let subscribers = 0
    hive.store.subscribeDispatchQuestionChanges = (workspaceId, listener) => {
      const unsubscribe = subscribe(workspaceId, listener)
      subscribers++
      return () => {
        subscribers--
        unsubscribe()
      }
    }
    const assignment = await hive.store.dispatchTaskByWorkerName(workspace.id, 'Bob', 'Wait', {
      fromAgentId: orchestratorId,
    })
    const ask = await post('ask', outsider.id, {
      dispatch_id: assignment.id,
      text: 'Still waiting?',
    })
    const { message: pending } = (await ask.json()) as { message: { id: string } }
    const abort = new AbortController()
    const aborted = post(
      'question',
      outsider.id,
      { question_id: pending.id, wait_ms: 60000 },
      abort.signal
    )
    await expect.poll(() => subscribers).toBe(1)
    abort.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await expect.poll(() => subscribers).toBe(0)

    const waitForDeletion = post('question', orchestratorId, {
      question_id: pending.id,
      wait_ms: 60000,
    })
    await expect.poll(() => subscribers).toBe(1)
    await hive.store.deleteWorkspace(workspace.id)
    expect((await waitForDeletion).status).toBe(409)
    expect(subscribers).toBe(0)

    const secondWorkspace = hive.store.createWorkspace(workspacePath, 'Shutdown')
    const secondOrch = `${secondWorkspace.id}:orchestrator`
    const secondWorker = hive.store.addWorker(secondWorkspace.id, { name: 'Carol', role: 'coder' })
    for (const agentId of [secondOrch, secondWorker.id]) {
      hive.store.configureAgentLaunch(secondWorkspace.id, agentId, {
        command: process.execPath,
        args: [script, join(dataDir, 'shutdown-output')],
      })
      await hive.store.startAgent(secondWorkspace.id, agentId, { hivePort: String(hive.port) })
    }
    const secondDispatch = await hive.store.dispatchTaskByWorkerName(
      secondWorkspace.id,
      'Carol',
      'Wait',
      { fromAgentId: secondOrch }
    )
    const secondQuestion = hive.store.sendDispatchMessage(secondWorkspace.id, secondWorker.id, {
      dispatchId: secondDispatch.id,
      kind: 'question',
      recipient: 'orchestrator',
      text: 'Shutdown?',
    })
    const shutdownWait = fetch(`${baseUrl}/api/team/question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: secondWorkspace.id,
        from_agent_id: secondOrch,
        token: hive.store.peekAgentToken(secondOrch),
        question_id: secondQuestion.id,
        wait_ms: 60000,
      }),
    })
    await expect.poll(() => subscribers).toBe(1)
    const closing = hive.store.close()
    expect(await (await shutdownWait).json()).toMatchObject({ status: 'pending' })
    await closing
    expect(subscribers).toBe(0)
  } finally {
    await hive.close()
  }
}, 30000)
