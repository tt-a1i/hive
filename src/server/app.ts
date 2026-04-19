import { createServer, type ServerResponse } from 'node:http'

import { HttpError } from './http-errors.js'
import { matchRoute } from './routes.js'
import type { RuntimeStore } from './runtime-store.js'
import { createTasksFileService, type TasksFileService } from './tasks-file.js'

interface CreateAppOptions {
  store: RuntimeStore
  tasksFileService?: TasksFileService
}

const sendJson = (response: ServerResponse, statusCode: number, body: unknown) => {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export const createApp = ({
  store,
  tasksFileService = createTasksFileService(),
}: CreateAppOptions) => {
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    try {
      const match = matchRoute(method, url.pathname)
      if (match) {
        await match.handler({
          request,
          response,
          store,
          tasksFileService,
          params: match.params,
        })
        return
      }

      sendJson(response, 404, { error: 'Not found' })
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: error.message })
        return
      }
      const message = error instanceof Error ? error.message : 'Unknown error'
      sendJson(response, 500, { error: message })
    }
  })

  return { server, store }
}

export type { CreateAppOptions }
