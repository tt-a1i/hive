import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type PickFolderResponse, pickFolder } from './fs-pick-folder.js'
import { HttpError } from './http-errors.js'
import { matchRoute } from './routes.js'
import type { RuntimeStore } from './runtime-store.js'
import { createTasksFileService, type TasksFileService } from './tasks-file.js'
import { createTerminalWebSocketServer } from './terminal-ws-server.js'

interface CreateAppOptions {
  store: RuntimeStore
  pickFolderService?: () => Promise<PickFolderResponse>
  tasksFileService?: TasksFileService
}

const getDefaultStaticDir = () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  if (moduleDir.includes(`${sep}dist${sep}src${sep}`)) {
    return resolve(moduleDir, '../../../web/dist')
  }
  return resolve(moduleDir, '../../web/dist')
}

const isReservedPath = (pathname: string) => /^\/(api|ws)(\/|$)/.test(pathname)

const canServeStatic = async (staticDir: string) => {
  try {
    await access(join(staticDir, 'index.html'), constants.F_OK)
    return true
  } catch {
    return false
  }
}

const getStaticAssetPath = (staticDir: string, pathname: string) => {
  const staticRoot = resolve(staticDir)
  if (pathname === '/' || extname(pathname) === '') return join(staticRoot, 'index.html')
  const candidate = resolve(staticRoot, `.${pathname}`)
  if (candidate === staticRoot || candidate.startsWith(`${staticRoot}${sep}`)) return candidate
  return undefined
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

const sendStatic = async (
  response: ServerResponse,
  staticDir: string,
  pathname: string,
  request: IncomingMessage
) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const filePath = getStaticAssetPath(staticDir, pathname)
  if (!filePath) return false
  try {
    const content = await readFile(filePath)
    response.setHeader(
      'content-type',
      CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream'
    )
    response.statusCode = 200
    response.end(request.method === 'HEAD' ? undefined : content)
    return true
  } catch {
    return false
  }
}

const sendJson = (response: ServerResponse, statusCode: number, body: unknown) => {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export const createApp = ({
  store,
  pickFolderService = pickFolder,
  tasksFileService = createTasksFileService(),
}: CreateAppOptions) => {
  const staticDir = process.env.HIVE_STATIC_DIR ?? getDefaultStaticDir()
  const staticAvailablePromise = canServeStatic(staticDir)
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
          pickFolderService,
          params: match.params,
        })
        return
      }

      if (isReservedPath(url.pathname)) {
        sendJson(response, 404, { error: 'Not found' })
        return
      }

      if (await staticAvailablePromise) {
        const served = await sendStatic(response, staticDir, url.pathname, request)
        if (served) return
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
  createTerminalWebSocketServer(server, store)

  return { server, store }
}

export type { CreateAppOptions }
