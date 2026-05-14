import type { IncomingMessage, Server } from 'node:http'

import { WebSocketServer } from 'ws'
import { getLocalRequestRejection } from './local-request-guard.js'
import type { RuntimeStore } from './runtime-store.js'
import { createTasksWebSocketServer } from './tasks-websocket-server.js'
import type { TerminalMirrorSize } from './terminal-state-mirror.js'
import { createTerminalStreamHub } from './terminal-stream-hub.js'
import { readCookie } from './ui-auth-helpers.js'

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

const rejectUpgrade = (
  socket: Parameters<Server['on']>[1] extends (...args: infer T) => void ? T[1] : never,
  status: string
) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
  socket.destroy()
}

export const createTerminalWebSocketServer = (server: Server, store: RuntimeStore) => {
  const ioWss = new WebSocketServer({ noServer: true })
  const controlWss = new WebSocketServer({ noServer: true })
  const tasksWss = createTasksWebSocketServer(server, store)
  const hub = createTerminalStreamHub(store)
  const disposeTasksListener = store.registerTasksListener((workspaceId, content) => {
    tasksWss.publish(workspaceId, content)
  })

  const validateUpgradeSession = (request: IncomingMessage) => {
    const cookieHeader = Array.isArray(request.headers.cookie)
      ? request.headers.cookie.join('; ')
      : request.headers.cookie
    const token = readCookie(cookieHeader, 'hive_ui_token')
    return store.validateUiToken(token)
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const match = matchTerminalPath(pathname)
    if (!match) {
      if (/^\/ws\/tasks\/.+/.test(pathname)) {
        return
      }
      rejectUpgrade(socket, '404 Not Found')
      return
    }
    if (getLocalRequestRejection(request)) {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    if (!validateUpgradeSession(request)) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }

    try {
      store.getLiveRun(match.runId)
    } catch {
      rejectUpgrade(socket, '404 Not Found')
      return
    }

    const wss = match.channel === 'io' ? ioWss : controlWss
    wss.handleUpgrade(request, socket, head, (ws) => {
      const clientId = getClientId(url)
      if (match.channel === 'io') hub.attachIo(match.runId, clientId, ws, getInitialSize(url))
      else hub.attachControl(match.runId, clientId, ws, getInitialSize(url))
    })
  })

  server.on('close', () => {
    disposeTasksListener()
    hub.close()
    ioWss.close()
    controlWss.close()
    tasksWss.close()
  })

  return { close: () => hub.close() }
}
