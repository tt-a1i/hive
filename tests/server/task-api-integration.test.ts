import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

interface TestContext {
  baseUrl: string
  close: () => Promise<void>
  cookie: string
  orchAgentId: string
  orchToken: string
  workerAgentId: string
  workerToken: string
  workspaceId: string
}

const setup = async (): Promise<TestContext> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-task-api-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)
  const passiveScript = join(workspacePath, 'passive.js')
  writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

  const ctx = await startTestServer({ dataDir })
  const { baseUrl, store } = ctx
  const cookie = await getUiCookie(baseUrl)

  const wsRes = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'TaskTest', path: workspacePath, autostart_orchestrator: false }),
  })
  const ws = (await wsRes.json()) as { id: string }
  const workspaceId = ws.id
  const orchAgentId = `${workspaceId}:orchestrator`

  const workerRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Coder', role: 'coder', autostart: false }),
  })
  const worker = (await workerRes.json()) as { id: string }
  const workerAgentId = worker.id

  const bashCmd = '/bin/bash'
  const bashArgs = ['-lc', `"${process.execPath}" "${passiveScript}"`]

  for (const agentId of [orchAgentId, workerAgentId]) {
    await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ command: bashCmd, args: bashArgs }),
    })
    await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ hive_port: String(new URL(baseUrl).port) }),
    })
  }

  const orchToken = store.peekAgentToken(orchAgentId) ?? ''
  const workerToken = store.peekAgentToken(workerAgentId) ?? ''

  return {
    baseUrl,
    close: ctx.close,
    cookie,
    orchAgentId,
    orchToken,
    workerAgentId,
    workerToken,
    workspaceId,
  }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const json = () => ({ 'content-type': 'application/json' })

describe('task-api integration: full lifecycle', () => {
  test('create task returns 201 with task object', async () => {
    const ctx = await setup()
    try {
      const res = await fetch(`${ctx.baseUrl}/api/team/tasks`, {
        method: 'POST',
        headers: { ...json(), cookie: ctx.cookie },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, title: 'Implement login', source: 'orch' }),
      })
      expect(res.status).toBe(201)
      const data = (await res.json()) as { ok: boolean; task: { id: string; title: string; status: string } }
      expect(data.ok).toBe(true)
      expect(data.task.id).toBeDefined()
      expect(data.task.title).toBe('Implement login')
      expect(data.task.status).toBe('open')
    } finally {
      await ctx.close()
    }
  })

  test('list tasks returns created tasks', async () => {
    const ctx = await setup()
    try {
      await fetch(`${ctx.baseUrl}/api/team/tasks`, {
        method: 'POST',
        headers: { ...json(), cookie: ctx.cookie },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, title: 'Task A', source: 'orch' }),
      })
      await fetch(`${ctx.baseUrl}/api/team/tasks`, {
        method: 'POST',
        headers: { ...json(), cookie: ctx.cookie },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, title: 'Task B', source: 'orch' }),
      })

      const res = await fetch(
        `${ctx.baseUrl}/api/team/tasks?workspace_id=${ctx.workspaceId}`,
        { headers: { cookie: ctx.cookie } }
      )
      expect(res.status).toBe(200)
      const data = (await res.json()) as { tasks: Array<{ title: string }> }
      expect(data.tasks.length).toBeGreaterThanOrEqual(2)
      expect(data.tasks.map((t) => t.title)).toContain('Task A')
      expect(data.tasks.map((t) => t.title)).toContain('Task B')
    } finally {
      await ctx.close()
    }
  })

  test('team send with task_id links dispatch to task and sets in_progress', async () => {
    const ctx = await setup()
    try {
      const taskRes = await fetch(`${ctx.baseUrl}/api/team/tasks`, {
        method: 'POST',
        headers: { ...json(), cookie: ctx.cookie },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, title: 'Auth middleware', source: 'orch' }),
      })
      const { task } = (await taskRes.json()) as { task: { id: string; status: string } }
      expect(task.status).toBe('open')

      const sendRes = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: json(),
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchAgentId,
          token: ctx.orchToken,
          to: 'Coder',
          text: 'Write auth middleware',
          task_id: task.id,
        }),
      })
      expect(sendRes.status).toBe(202)
      const sendData = (await sendRes.json()) as { dispatch_id: string; task_id: string }
      expect(sendData.task_id).toBe(task.id)

      const detailRes = await fetch(
        `${ctx.baseUrl}/api/team/tasks/${task.id}?workspace_id=${ctx.workspaceId}`,
        { headers: { cookie: ctx.cookie } }
      )
      expect(detailRes.status).toBe(200)
      const detail = (await detailRes.json()) as {
        task: { status: string }
        dispatches: Array<{ id: string }>
      }
      expect(detail.task.status).toBe('in_progress')
      expect(detail.dispatches.length).toBe(1)
      expect(detail.dispatches[0]!.id).toBe(sendData.dispatch_id)
    } finally {
      await ctx.close()
    }
  })

  test('team send with --create-task creates and links task', async () => {
    const ctx = await setup()
    try {
      const sendRes = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: json(),
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchAgentId,
          token: ctx.orchToken,
          to: 'Coder',
          text: 'Implement OAuth flow',
          create_task: true,
        }),
      })
      expect(sendRes.status).toBe(202)
      const sendData = (await sendRes.json()) as { dispatch_id: string; task_id: string }
      expect(sendData.task_id).toBeDefined()

      const detailRes = await fetch(
        `${ctx.baseUrl}/api/team/tasks/${sendData.task_id}?workspace_id=${ctx.workspaceId}`,
        { headers: { cookie: ctx.cookie } }
      )
      expect(detailRes.status).toBe(200)
      const detail = (await detailRes.json()) as {
        task: { title: string; status: string; source: string }
      }
      expect(detail.task.title).toBe('Implement OAuth flow')
      expect(detail.task.status).toBe('in_progress')
      expect(detail.task.source).toBe('orch')
    } finally {
      await ctx.close()
    }
  })

  test('team report records suggestion event on linked task', async () => {
    const ctx = await setup()
    try {
      const taskRes = await fetch(`${ctx.baseUrl}/api/team/tasks`, {
        method: 'POST',
        headers: { ...json(), cookie: ctx.cookie },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, title: 'Write tests', source: 'orch' }),
      })
      const { task } = (await taskRes.json()) as { task: { id: string } }

      const sendRes = await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: json(),
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchAgentId,
          token: ctx.orchToken,
          to: 'Coder',
          text: 'Write unit tests',
          task_id: task.id,
        }),
      })
      const { dispatch_id } = (await sendRes.json()) as { dispatch_id: string }

      const reportRes = await fetch(`${ctx.baseUrl}/api/team/report`, {
        method: 'POST',
        headers: json(),
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.workerAgentId,
          token: ctx.workerToken,
          result: 'Tests written and passing',
          dispatch_id,
        }),
      })
      expect(reportRes.status).toBe(202)

      const detailRes = await fetch(
        `${ctx.baseUrl}/api/team/tasks/${task.id}?workspace_id=${ctx.workspaceId}`,
        { headers: { cookie: ctx.cookie } }
      )
      const detail = (await detailRes.json()) as {
        recentEvents: Array<{ eventType: string; dispatchId: string | null }>
      }
      const suggestion = detail.recentEvents.find((e) => e.eventType === 'report_suggested')
      expect(suggestion).toBeDefined()
      expect(suggestion!.dispatchId).toBe(dispatch_id)
    } finally {
      await ctx.close()
    }
  })

  test('update task status to done', async () => {
    const ctx = await setup()
    try {
      const taskRes = await fetch(`${ctx.baseUrl}/api/team/tasks`, {
        method: 'POST',
        headers: { ...json(), cookie: ctx.cookie },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, title: 'Finish login', source: 'orch' }),
      })
      const { task } = (await taskRes.json()) as { task: { id: string } }

      const updateRes = await fetch(`${ctx.baseUrl}/api/team/tasks/${task.id}/status`, {
        method: 'POST',
        headers: { ...json(), cookie: ctx.cookie },
        body: JSON.stringify({ status: 'done' }),
      })
      expect(updateRes.status).toBe(200)
      const data = (await updateRes.json()) as { ok: boolean; task: { status: string } }
      expect(data.ok).toBe(true)
      expect(data.task.status).toBe('done')
    } finally {
      await ctx.close()
    }
  })

  test('worker cannot create tasks (permission denied)', async () => {
    const ctx = await setup()
    try {
      const res = await fetch(`${ctx.baseUrl}/api/team/tasks`, {
        method: 'POST',
        headers: json(),
        body: JSON.stringify({
          workspace_id: ctx.workspaceId,
          from_agent_id: ctx.workerAgentId,
          token: ctx.workerToken,
          title: 'Worker task',
          source: 'orch',
        }),
      })
      expect(res.status).toBe(403)
    } finally {
      await ctx.close()
    }
  })

  test('get task detail returns task + dispatches + events', async () => {
    const ctx = await setup()
    try {
      const taskRes = await fetch(`${ctx.baseUrl}/api/team/tasks`, {
        method: 'POST',
        headers: { ...json(), cookie: ctx.cookie },
        body: JSON.stringify({ workspace_id: ctx.workspaceId, title: 'Full detail test', source: 'orch' }),
      })
      const { task } = (await taskRes.json()) as { task: { id: string } }

      await fetch(`${ctx.baseUrl}/api/team/send`, {
        method: 'POST',
        headers: json(),
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchAgentId,
          token: ctx.orchToken,
          to: 'Coder',
          text: 'Do the work',
          task_id: task.id,
        }),
      })

      const detailRes = await fetch(
        `${ctx.baseUrl}/api/team/tasks/${task.id}?workspace_id=${ctx.workspaceId}`,
        { headers: { cookie: ctx.cookie } }
      )
      expect(detailRes.status).toBe(200)
      const detail = (await detailRes.json()) as {
        task: { id: string; title: string; status: string }
        dispatches: Array<{ id: string; text: string }>
        recentEvents: Array<{ eventType: string }>
      }
      expect(detail.task.id).toBe(task.id)
      expect(detail.task.title).toBe('Full detail test')
      expect(detail.task.status).toBe('in_progress')
      expect(detail.dispatches.length).toBe(1)
      expect(detail.dispatches[0]!.text).toBe('Do the work')
      expect(detail.recentEvents.some((e) => e.eventType === 'created')).toBe(true)
      expect(detail.recentEvents.some((e) => e.eventType === 'dispatched')).toBe(true)
    } finally {
      await ctx.close()
    }
  })
})
