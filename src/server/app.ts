import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import type { WorkerRole } from '../shared/types.js'
import type { RuntimeStore } from './runtime-store.js'

interface CreateAppOptions {
  store: RuntimeStore
}

interface SendTaskBody {
  projectId: string
  fromAgentId: string
  to: string
  text: string
}

interface ReportTaskBody {
  projectId: string
  fromAgentId: string
  result: string
  status: string
  artifacts: unknown[]
}

interface CreateWorkspaceBody {
  path: string
  name: string
}

interface CreateWorkerBody {
  name: string
  role: WorkerRole
}

const sendJson = (response: ServerResponse, statusCode: number, body: unknown) => {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

const readJsonBody = async <T>(request: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

export const createApp = ({ store }: CreateAppOptions) => {
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    try {
      if (method === 'GET' && url.pathname === '/api/workspaces') {
        sendJson(response, 200, store.listWorkspaces())
        return
      }

      if (method === 'POST' && url.pathname === '/api/workspaces') {
        const body = await readJsonBody<CreateWorkspaceBody>(request)
        sendJson(response, 201, store.createWorkspace(body.path, body.name))
        return
      }

      if (method === 'GET' && /^\/api\/workspaces\/[^/]+\/team$/.test(url.pathname)) {
        const workspaceId = url.pathname.split('/')[3]
        if (!workspaceId) {
          sendJson(response, 400, { error: 'Workspace id is required' })
          return
        }

        sendJson(response, 200, store.listWorkers(workspaceId))
        return
      }

      if (method === 'POST' && /^\/api\/workspaces\/[^/]+\/workers$/.test(url.pathname)) {
        const workspaceId = url.pathname.split('/')[3]
        if (!workspaceId) {
          sendJson(response, 400, { error: 'Workspace id is required' })
          return
        }

        const body = await readJsonBody<CreateWorkerBody>(request)
        sendJson(response, 201, store.addWorker(workspaceId, body))
        return
      }

      if (method === 'POST' && url.pathname === '/api/team/send') {
        const body = await readJsonBody<SendTaskBody>(request)
        store.dispatchTask(body.projectId, body.to, body.text)
        sendJson(response, 202, { ok: true })
        return
      }

      if (method === 'POST' && url.pathname === '/api/team/report') {
        const body = await readJsonBody<ReportTaskBody>(request)
        store.reportTask(body.projectId, body.fromAgentId)
        sendJson(response, 202, { ok: true })
        return
      }

      sendJson(response, 404, { error: 'Not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      sendJson(response, 500, { error: message })
    }
  })

  return { server }
}

export type {
  CreateAppOptions,
  CreateWorkerBody,
  CreateWorkspaceBody,
  ReportTaskBody,
  SendTaskBody,
  WorkerRole,
}
