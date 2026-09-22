import type { IncomingMessage, Server } from 'node:http'

import { WebSocketServer } from 'ws'
import { getLocalRequestRejection } from './local-request-guard.js'
import type { RuntimeStore } from './runtime-store.js'
import type { TasksFileService } from './tasks-file.js'
import { createTasksWebSocketServer } from './tasks-websocket-server.js'
import type { TerminalMirrorSize } from './terminal-state-mirror.js'
import { createTerminalStreamHub } from './terminal-stream-hub.js'
import { readCookie } from './ui-auth-helpers.js'
import {
  attachRawSocketErrorHandler,
  attachWebSocketServerErrorHandler,
  rejectWebSocketUpgrade,
} from './websocket-upgrade-safety.js'

const matchTerminalPath = (pathname: string) => {
  const match = /^\/ws\/terminal\/(?<runId>[^/]+)\/(?<channel>io|control)$/.exec(pathname)
  const groups = match?.groups
  if (!groups?.runId || !groups.channel) return null
  return {
    channel: groups.channel as 'control' | 'io',
    runId: decodeURIComponent(groups.runId),
  }
}

const getClientId = (url: URL) => {
  return url.searchParams.get('clientId')?.trim() || 'legacy'
}

const getInitialSize = (url: URL): TerminalMirrorSize | undefined => {
  const cols = Number(url.searchParams.get('cols'))
  const rows = Number(url.searchParams.get('rows'))
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    return undefined
  }
  return { cols, rows }
}

export const createTerminalWebSocketServer = (
  server: Server,
  store: RuntimeStore,
  tasksFileService: Pick<TasksFileService, 'readTasks'>
) => {
  const ioWss = new WebSocketServer({ noServer: true })
  const controlWss = new WebSocketServer({ noServer: true })
  attachWebSocketServerErrorHandler(ioWss, 'terminal io')
  attachWebSocketServerErrorHandler(controlWss, 'terminal control')
  const tasksWss = createTasksWebSocketServer(server, store, tasksFileService)
  const hub = createTerminalStreamHub(store)
  const disposeTasksListener = store.registerTasksListener((workspaceId, content) => {
    tasksWss.publish(workspaceId, content)
  })

  const validateUpgradeSession = (request: IncomingMessage) => {
    // Tunnel-originated upgrades carry the per-boot secret (invariant 2). A
    // request with no secret header falls straight to the cookie path, so
    // browser behavior is unchanged. getLocalRequestRejection still runs in
    // front (loopback Host), so this is reachable only from 127.0.0.1.
    if (store.authorizeRemoteTunnelRequest(request)) return true
    const cookieHeader = Array.isArray(request.headers.cookie)
      ? request.headers.cookie.join('; ')
      : request.headers.cookie
    const token = readCookie(cookieHeader, 'hive_ui_token')
    return store.validateUiToken(token)
  }

  let closed = false
  const closeAll = () => {
    if (closed) return
    closed = true
    // Order matters: dispose the publisher first so no new frames are
    // queued onto sockets that are about to be torn down. Then forcibly
    // terminate any open WS clients (terminate() skips the close
    // handshake, which is what we need — a polite ws.close() would wait
    // on the remote side and re-introduce the hang we're fixing).
    disposeTasksListener()
    for (const ws of ioWss.clients) ws.terminate()
    for (const ws of controlWss.clients) ws.terminate()
    tasksWss.close()
    ioWss.close()
    controlWss.close()
    hub.close()
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const match = matchTerminalPath(pathname)
    if (!match) {
      if (/^\/ws\/tasks\/.+/.test(pathname)) {
        return
      }
      attachRawSocketErrorHandler(socket, 'terminal upgrade')
      rejectWebSocketUpgrade(socket, '404 Not Found')
      return
    }
    const detachRawSocketErrorHandler = attachRawSocketErrorHandler(socket, 'terminal upgrade')
    if (getLocalRequestRejection(request)) {
      rejectWebSocketUpgrade(socket, '403 Forbidden')
      return
    }
    if (!validateUpgradeSession(request)) {
      rejectWebSocketUpgrade(socket, '401 Unauthorized')
      return
    }

    try {
      store.getLiveRun(match.runId)
    } catch {
      rejectWebSocketUpgrade(socket, '404 Not Found')
      return
    }

    const wss = match.channel === 'io' ? ioWss : controlWss
    wss.handleUpgrade(request, socket, head, (ws) => {
      detachRawSocketErrorHandler()
      const clientId = getClientId(url)
      const renderEvents = url.searchParams.get('render_events') === '1'
      if (match.channel === 'io')
        hub.attachIo(match.runId, clientId, ws, getInitialSize(url), renderEvents)
      else hub.attachControl(match.runId, clientId, ws, getInitialSize(url), renderEvents)
    })
  })

  // Kept as an idempotent fallback for callers that drive
  // `app.server.close()` directly (e.g. unit tests in tests/server/*)
  // and never see the runHiveCommand close path. closeAll() is guarded
  // by `closed` so calling both is a no-op.
  server.on('close', closeAll)

  return { close: closeAll }
}
