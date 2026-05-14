import type { IncomingMessage, Server } from 'node:http'

import type { WebSocket as WsSocket } from 'ws'
import { WebSocketServer } from 'ws'

import { getLocalRequestRejection } from './local-request-guard.js'
import type { RuntimeStore } from './runtime-store.js'
import { readCookie } from './ui-auth-helpers.js'

const matchTasksPath = (pathname: string) => {
  const match = /^\/ws\/tasks\/(?<workspaceId>[^/]+)$/.exec(pathname)
  const workspaceId = match?.groups?.workspaceId
  return workspaceId ? decodeURIComponent(workspaceId) : null
}

const rejectUpgrade = (
  socket: Parameters<Server['on']>[1] extends (...args: infer T) => void ? T[1] : never,
  status: string
) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
  socket.destroy()
}

export interface TasksWebSocketServer {
  close: () => void
  publish: (workspaceId: string, content: string) => void
}

export const createTasksWebSocketServer = (
  server: Server,
  store: RuntimeStore
): TasksWebSocketServer => {
  const wss = new WebSocketServer({ noServer: true })
  const socketsByWorkspaceId = new Map<string, Set<WsSocket>>()

  const validateUpgradeSession = (request: IncomingMessage) => {
    const cookieHeader = Array.isArray(request.headers.cookie)
      ? request.headers.cookie.join('; ')
      : request.headers.cookie
    const token = readCookie(cookieHeader, 'hive_ui_token')
    return store.validateUiToken(token)
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const workspaceId = matchTasksPath(url.pathname)
    if (!workspaceId) return
    if (getLocalRequestRejection(request)) {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    if (!validateUpgradeSession(request)) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }
    try {
      store.getWorkspaceSnapshot(workspaceId)
    } catch {
      rejectUpgrade(socket, '404 Not Found')
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const sockets = socketsByWorkspaceId.get(workspaceId) ?? new Set<WsSocket>()
      sockets.add(ws)
      socketsByWorkspaceId.set(workspaceId, sockets)
      ws.on('close', () => {
        sockets.delete(ws)
        if (sockets.size === 0) {
          socketsByWorkspaceId.delete(workspaceId)
        }
      })
    })
  })

  return {
    close: () => {
      for (const sockets of socketsByWorkspaceId.values()) {
        for (const socket of sockets) socket.close()
      }
      socketsByWorkspaceId.clear()
      wss.close()
    },
    publish: (workspaceId, content) => {
      const sockets = socketsByWorkspaceId.get(workspaceId)
      if (!sockets) return
      const payload = JSON.stringify({ type: 'tasks-updated', content })
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload)
        }
      }
    },
  }
}
