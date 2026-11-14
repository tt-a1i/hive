import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type PickFolderResponse, pickFolder } from './fs-pick-folder.js'
import { HttpError } from './http-errors.js'
import { assertLocalRequest } from './local-request-guard.js'
import { openWorkspace } from './open-target-commands.js'
import { readPackageVersion } from './package-version.js'
import { requireJsonContentType } from './route-helpers.js'
import type { OpenWorkspaceService } from './route-types.js'
import { matchRoute } from './routes.js'
import type { RuntimeStore } from './runtime-store.js'
import { createTasksFileService, type TasksFileService } from './tasks-file.js'
import { createTerminalWebSocketServer } from './terminal-ws-server.js'
import { createVersionService, type VersionService } from './version-service.js'

interface CreateAppOptions {
  store: RuntimeStore
  pickFolderService?: () => Promise<PickFolderResponse>
  openWorkspaceService?: OpenWorkspaceService
  packageVersionReader?: () => string
  tasksFileService?: TasksFileService
  versionService?: VersionService
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

// PWA boot files must bypass HTTP caching: `sw.js` because the browser does its
// own byte-diff update check, and the manifest because Chrome consults it on
// every install/uninstall transition. Without these, SW updates can stall on a
// stale cached copy and the install prompt won't reflect a renamed app.
const PWA_BOOT_CACHE_CONTROL: Record<string, string> = {
  '/manifest.webmanifest': 'max-age=0, must-revalidate',
  '/sw.js': 'no-store',
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
    const cacheControl = PWA_BOOT_CACHE_CONTROL[pathname]
    if (cacheControl !== undefined) response.setHeader('cache-control', cacheControl)
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

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const createVersionMismatchBody = (
  runtimeVersion: string,
  installedVersion: string
) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Restart Hive</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { align-items: center; background: #0d0f12; color: #f4f4f5; display: flex; justify-content: center; margin: 0; min-height: 100vh; }
      main { border: 1px solid rgba(255,255,255,.12); border-radius: 14px; background: #17191d; box-shadow: 0 18px 64px rgba(0,0,0,.4); max-width: 520px; padding: 28px; }
      h1 { font-size: 22px; line-height: 1.2; margin: 0 0 10px; }
      p { color: #a1a1aa; font-size: 14px; line-height: 1.6; margin: 0 0 14px; }
      code { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.1); border-radius: 6px; color: #e5e7eb; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Restart Hive</h1>
      <p>Hive was updated on disk while this runtime process was still running.</p>
      <p>Running runtime: <code>${escapeHtml(runtimeVersion)}</code><br />Installed package: <code>${escapeHtml(installedVersion)}</code></p>
      <p>Stop the current <code>hive</code> process and start it again to load the new UI and API together.</p>
    </main>
  </body>
</html>`

const readVersionMismatch = (
  runtimeVersion: string,
  packageVersionReader: () => string
): { installedVersion: string; runtimeVersion: string } | null => {
  const installedVersion = packageVersionReader()
  if (
    runtimeVersion === 'unknown' ||
    installedVersion === 'unknown' ||
    installedVersion === runtimeVersion
  ) {
    return null
  }
  return { installedVersion, runtimeVersion }
}

const sendVersionMismatchJson = (
  response: ServerResponse,
  mismatch: { installedVersion: string; runtimeVersion: string }
) => {
  sendJson(response, 409, {
    code: 'runtime_version_mismatch',
    current_version: mismatch.runtimeVersion,
    error: 'Hive was updated on disk. Restart the running hive process to use the new version.',
    installed_version: mismatch.installedVersion,
  })
}

const sendVersionMismatchPage = (
  response: ServerResponse,
  request: IncomingMessage,
  mismatch: { installedVersion: string; runtimeVersion: string }
) => {
  response.statusCode = 409
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(
    request.method === 'HEAD'
      ? undefined
      : createVersionMismatchBody(mismatch.runtimeVersion, mismatch.installedVersion)
  )
}

export const createApp = ({
  store,
  pickFolderService = pickFolder,
  openWorkspaceService = (input) => openWorkspace(input),
  packageVersionReader = readPackageVersion,
  tasksFileService = createTasksFileService(),
  versionService = createVersionService(),
}: CreateAppOptions) => {
  const staticDir = process.env.HIVE_STATIC_DIR ?? getDefaultStaticDir()
  const runtimeVersion = packageVersionReader()
  const staticAvailablePromise = canServeStatic(staticDir)
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    try {
      assertLocalRequest(request)
      if (
        isReservedPath(url.pathname) &&
        (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) > 0)
      ) {
        requireJsonContentType(request)
      }

      const match = matchRoute(method, url.pathname)
      if (match) {
        await match.handler({
          request,
          response,
          store,
          tasksFileService,
          pickFolderService,
          openWorkspaceService,
          versionService,
          params: match.params,
        })
        return
      }

      if (isReservedPath(url.pathname)) {
        const mismatch = readVersionMismatch(runtimeVersion, packageVersionReader)
        if (mismatch) {
          sendVersionMismatchJson(response, mismatch)
          return
        }
        sendJson(response, 404, { error: 'Not found' })
        return
      }

      if (await staticAvailablePromise) {
        const mismatch = readVersionMismatch(runtimeVersion, packageVersionReader)
        if (mismatch) {
          sendVersionMismatchPage(response, request, mismatch)
          return
        }
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
  const wsServer = createTerminalWebSocketServer(server, store, tasksFileService)

  return {
    server,
    store,
    // Tear-down for the WebSocket layer. Callers must invoke this
    // BEFORE awaiting `server.close()` if they want a prompt return:
    // `server.close()` waits on every existing socket, and Node's
    // `closeAllConnections()` does NOT terminate already-upgraded
    // WebSocket clients. Without this hook a Ctrl+C in the Hive
    // runtime hangs as long as any browser tab is connected.
    closeWebSockets: wsServer.close,
  }
}

export type { CreateAppOptions }
