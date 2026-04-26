import type WebSocket from 'ws'

import type { RuntimeStore } from './runtime-store.js'
import { createTerminalOutputFlow } from './terminal-flow-control.js'
import {
  parseTerminalControlMessage,
  serializeTerminalError,
  serializeTerminalExit,
  serializeTerminalRestore,
} from './terminal-protocol.js'
import { type TerminalMirrorSize, TerminalStateMirror } from './terminal-state-mirror.js'

interface ViewerState {
  clientId: string
  controlSocket: WebSocket | null
  flowState: ReturnType<typeof createTerminalOutputFlow> | null
  ioSocket: WebSocket | null
}

interface RunState {
  backpressuredViewerIds: Set<string>
  exited: boolean
  exitInterval: ReturnType<typeof setInterval> | null
  mirror: TerminalStateMirror
  outputUnsubscribe: (() => void) | null
  viewers: Map<string, ViewerState>
}

export interface TerminalStreamHub {
  attachControl: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize
  ) => void
  attachIo: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize
  ) => void
  close: () => void
}

export const createTerminalStreamHub = (store: RuntimeStore): TerminalStreamHub => {
  const runStates = new Map<string, RunState>()

  const maybeResumeRun = (runId: string, state: RunState, clientId: string) => {
    if (!state.backpressuredViewerIds.delete(clientId)) return
    if (state.backpressuredViewerIds.size === 0) store.resumeTerminalRun(runId)
  }

  const cleanupRun = (runId: string) => {
    const state = runStates.get(runId)
    if (!state?.exited || state.viewers.size > 0) return
    state.outputUnsubscribe?.()
    if (state.exitInterval) clearInterval(state.exitInterval)
    state.mirror.dispose()
    runStates.delete(runId)
  }

  const getOrCreateViewer = (state: RunState, clientId: string) => {
    let viewer = state.viewers.get(clientId)
    if (!viewer) {
      viewer = { clientId, controlSocket: null, flowState: null, ioSocket: null }
      state.viewers.set(clientId, viewer)
    }
    return viewer
  }

  const getOrCreateState = (runId: string, initialSize?: TerminalMirrorSize) => {
    let state = runStates.get(runId)
    if (!state) {
      state = {
        backpressuredViewerIds: new Set(),
        exited: false,
        exitInterval: null,
        // runId is globally unique, so it is semantically equivalent to workspaceId:runId.
        mirror: new TerminalStateMirror(initialSize),
        outputUnsubscribe: null,
        viewers: new Map(),
      }
      runStates.set(runId, state)
      const liveRun = store.getLiveRun(runId)
      if (liveRun.output.length > 0) state.mirror.write(liveRun.output)
      const nextState = state
      nextState.outputUnsubscribe = store.getPtyOutputBus().subscribe(runId, (chunk) => {
        nextState.mirror.write(chunk)
        for (const viewer of nextState.viewers.values()) viewer.flowState?.enqueue(chunk)
      })
    } else if (initialSize) {
      state.mirror.resize(initialSize.cols, initialSize.rows)
    }
    return state
  }

  const cleanupViewer = (runId: string, state: RunState, clientId: string) => {
    const viewer = state.viewers.get(clientId)
    if (!viewer || viewer.controlSocket || viewer.ioSocket) return
    state.viewers.delete(clientId)
    maybeResumeRun(runId, state, clientId)
    cleanupRun(runId)
  }

  const startExitWatcher = (runId: string, state: RunState) => {
    if (state.exitInterval) return
    state.exitInterval = setInterval(() => {
      try {
        const run = store.getLiveRun(runId)
        if (run.status !== 'exited' && run.status !== 'error') return
        state.exited = true
        state.outputUnsubscribe?.()
        state.outputUnsubscribe = null
        const payload = serializeTerminalExit(run.exitCode)
        for (const viewer of state.viewers.values()) {
          const controlSocket = viewer.controlSocket
          if (controlSocket && controlSocket.readyState === controlSocket.OPEN)
            controlSocket.send(payload)
        }
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
    attachControl(runId, clientId, socket, initialSize) {
      const state = getOrCreateState(runId, initialSize)
      const viewer = getOrCreateViewer(state, clientId)
      viewer.controlSocket = socket
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
          if (message.type === 'output_ack') viewer.flowState?.ack(message.bytes)
          if (message.type === 'resize') {
            state.mirror.resize(message.cols, message.rows)
            store.resizeAgentRun(runId, message.cols, message.rows)
          }
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
        if (viewer.controlSocket === socket) viewer.controlSocket = null
        cleanupViewer(runId, state, clientId)
      })
    },
    attachIo(runId, clientId, socket, initialSize) {
      const state = getOrCreateState(runId, initialSize)
      const viewer = getOrCreateViewer(state, clientId)
      viewer.ioSocket = socket
      viewer.flowState?.close()
      viewer.flowState = createTerminalOutputFlow(socket, {
        onBackpressureChange(backpressured) {
          if (backpressured) {
            const wasEmpty = state.backpressuredViewerIds.size === 0
            state.backpressuredViewerIds.add(clientId)
            if (wasEmpty) store.pauseTerminalRun(runId)
            return
          }
          maybeResumeRun(runId, state, clientId)
        },
      })
      socket.on('message', (raw) => {
        store.writeRunInput(runId, raw.toString())
      })
      socket.on('close', () => {
        if (viewer.ioSocket === socket) viewer.ioSocket = null
        viewer.flowState?.close()
        viewer.flowState = null
        cleanupViewer(runId, state, clientId)
      })
    },
    close() {
      for (const [runId, state] of runStates) {
        state.outputUnsubscribe?.()
        if (state.exitInterval) clearInterval(state.exitInterval)
        state.mirror.dispose()
        for (const viewer of state.viewers.values()) {
          viewer.flowState?.close()
          viewer.ioSocket?.close()
          viewer.controlSocket?.close()
        }
        runStates.delete(runId)
      }
    },
  }
}
