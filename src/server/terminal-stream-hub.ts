import type WebSocket from 'ws'

import type { RuntimeStore } from './runtime-store.js'
import {
  parseTerminalControlMessage,
  serializeTerminalError,
  serializeTerminalExit,
  serializeTerminalRestore,
} from './terminal-protocol.js'
import { TerminalStateMirror } from './terminal-state-mirror.js'

interface RunSockets {
  controlSockets: Set<WebSocket>
  exitInterval: ReturnType<typeof setInterval> | null
  ioSockets: Set<WebSocket>
  exited: boolean
  mirror: TerminalStateMirror
  outputUnsubscribe: (() => void) | null
}

export interface TerminalStreamHub {
  attachControl: (runId: string, socket: WebSocket) => void
  attachIo: (runId: string, socket: WebSocket) => void
  close: () => void
}

export const createTerminalStreamHub = (store: RuntimeStore): TerminalStreamHub => {
  const runSockets = new Map<string, RunSockets>()

  const getState = (runId: string) => {
    let state = runSockets.get(runId)
    if (!state) {
      // runId is already globally unique, so it is equivalent to the plan's workspaceId:runId key.
      state = {
        controlSockets: new Set(),
        exitInterval: null,
        exited: false,
        ioSockets: new Set(),
        mirror: new TerminalStateMirror(),
        outputUnsubscribe: null,
      }
      runSockets.set(runId, state)
      const liveRun = store.getLiveRun(runId)
      if (liveRun.output.length > 0) {
        state.mirror.write(liveRun.output)
      }
      const nextState = state
      nextState.outputUnsubscribe = store.getPtyOutputBus().subscribe(runId, (chunk) => {
        nextState.mirror.write(chunk)
        for (const client of nextState.ioSockets) {
          if (client.readyState === client.OPEN) client.send(chunk)
        }
      })
    }
    return state
  }

  const cleanupRun = (runId: string) => {
    const state = runSockets.get(runId)
    if (!state) return
    if (state.controlSockets.size > 0 || state.ioSockets.size > 0 || !state.exited) return
    state.outputUnsubscribe?.()
    if (state.exitInterval) clearInterval(state.exitInterval)
    state.mirror.dispose()
    runSockets.delete(runId)
  }

  const startExitWatcher = (runId: string, state: RunSockets) => {
    if (state.exitInterval) return
    state.exitInterval = setInterval(() => {
      try {
        const run = store.getLiveRun(runId)
        if (run.status !== 'exited' && run.status !== 'error') return
        state.exited = true
        state.outputUnsubscribe?.()
        state.outputUnsubscribe = null
        const payload = serializeTerminalExit(run.exitCode)
        for (const socket of state.controlSockets)
          if (socket.readyState === socket.OPEN) socket.send(payload)
        if (state.exitInterval) clearInterval(state.exitInterval)
        state.exitInterval = null
        cleanupRun(runId)
      } catch {
        if (state.exitInterval) clearInterval(state.exitInterval)
        state.exitInterval = null
      }
    }, 25)
  }

  return {
    attachControl(runId, socket) {
      const state = getState(runId)
      state.controlSockets.add(socket)
      startExitWatcher(runId, state)
      void state.mirror
        .getSnapshot()
        .then((snapshot) => {
          if (socket.readyState === socket.OPEN) socket.send(serializeTerminalRestore(snapshot))
        })
        .catch(() => {
          if (socket.readyState === socket.OPEN) socket.send(serializeTerminalRestore(''))
        })
      socket.on('message', (raw) => {
        try {
          const message = parseTerminalControlMessage(raw as Buffer | string)
          if (message.type === 'resize') store.resizeAgentRun(runId, message.cols, message.rows)
          if (message.type === 'stop') store.stopAgentRun(runId)
          if (message.type === 'restore_complete') return
        } catch (error) {
          socket.send(
            serializeTerminalError(
              error instanceof Error ? error.message : 'Invalid control message'
            )
          )
        }
      })
      socket.on('close', () => {
        state.controlSockets.delete(socket)
        cleanupRun(runId)
      })
    },
    attachIo(runId, socket) {
      const state = getState(runId)
      state.ioSockets.add(socket)
      socket.on('message', (raw) => {
        store.writeRunInput(runId, raw.toString())
      })
      socket.on('close', () => {
        state.ioSockets.delete(socket)
        cleanupRun(runId)
      })
    },
    close() {
      for (const [runId, state] of runSockets) {
        state.outputUnsubscribe?.()
        if (state.exitInterval) clearInterval(state.exitInterval)
        state.mirror.dispose()
        for (const socket of [...state.ioSockets, ...state.controlSockets]) socket.close()
        runSockets.delete(runId)
      }
    },
  }
}
