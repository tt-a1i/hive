import type WebSocket from 'ws'

import type { RuntimeStore } from './runtime-store.js'
import { createTerminalOutputFlow } from './terminal-flow-control.js'
import {
  parseTerminalControlMessage,
  parseTerminalRenderInput,
  serializeTerminalError,
  serializeTerminalExit,
  serializeTerminalRestore,
} from './terminal-protocol.js'
import { type TerminalMirrorSize, TerminalStateMirror } from './terminal-state-mirror.js'
import { attachWebSocketErrorHandler, sendWebSocketMessage } from './websocket-upgrade-safety.js'

interface ViewerState {
  clientId: string
  controlSocket: WebSocket | null
  flowState: ReturnType<typeof createTerminalOutputFlow> | null
  ioSocket: WebSocket | null
  snapshotStarted: boolean
  renderEvents: boolean
}

interface RunState {
  backpressuredViewerIds: Set<string>
  exited: boolean
  exitInterval: ReturnType<typeof setInterval> | null
  mirror: TerminalStateMirror
  outputUnsubscribe: (() => void) | null
  viewers: Map<string, ViewerState>
  size: TerminalMirrorSize
  inputOwner: string | null
}

const normalizeTerminalInput = (
  raw: ArrayBuffer | Buffer | Buffer[],
  isBinary: boolean
): Buffer | string => {
  const bytes = Buffer.isBuffer(raw)
    ? raw
    : Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.from(raw)
  return isBinary ? Buffer.from(bytes) : bytes.toString()
}

export interface TerminalStreamHub {
  attachControl: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize,
    renderEvents?: boolean
  ) => void
  attachIo: (
    runId: string,
    clientId: string,
    socket: WebSocket,
    initialSize?: TerminalMirrorSize,
    renderEvents?: boolean
  ) => void
  close: () => void
}

export const createTerminalStreamHub = (store: RuntimeStore): TerminalStreamHub => {
  const runStates = new Map<string, RunState>()

  const interactiveOwner = (state: RunState) => {
    const viewers = [...state.viewers.values()]
    const modern = viewers.some((viewer) => viewer.renderEvents)
    const eligible = viewers.filter(
      (viewer) => viewer.ioSocket?.readyState === 1 && (!modern || viewer.renderEvents)
    )
    // A legacy or disconnected owner cannot answer queries. Elect one live
    // viewer without letting an automatic reply change the shared PTY grid.
    return (
      eligible.find((viewer) => viewer.clientId === state.inputOwner)?.clientId ??
      eligible[0]?.clientId
    )
  }

  const rejectLegacyInteraction = (state: RunState, viewer: ViewerState) => {
    if (viewer.renderEvents || ![...state.viewers.values()].some((peer) => peer.renderEvents))
      return false
    // Raw legacy input cannot distinguish a keystroke from an automatic reply.
    // Keep its stream open so the old client shows the error instead of entering
    // its automatic reconnect loop. Refresh negotiates ordered input/resize.
    if (viewer.controlSocket)
      sendWebSocketMessage(
        viewer.controlSocket,
        serializeTerminalError(
          'Hive terminal was updated. Refresh this page before typing or resizing. 终端已更新，请刷新页面后继续输入。',
          'terminal_refresh_required'
        ),
        'terminal refresh required'
      )
    return true
  }

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
      viewer = {
        clientId,
        controlSocket: null,
        flowState: null,
        ioSocket: null,
        snapshotStarted: false,
        renderEvents: false,
      }
      state.viewers.set(clientId, viewer)
    }
    return viewer
  }

  const getOrCreateState = (runId: string) => {
    let state = runStates.get(runId)
    if (!state) {
      state = {
        backpressuredViewerIds: new Set(),
        exited: false,
        exitInterval: null,
        // runId is globally unique, so it is semantically equivalent to workspaceId:runId.
        // PTYs start at the default grid. A viewer's viewport must not be used
        // to reinterpret bytes already emitted at the PTY's original size.
        mirror: new TerminalStateMirror(),
        outputUnsubscribe: null,
        viewers: new Map(),
        size: { cols: 80, rows: 24 },
        inputOwner: null,
      }
      runStates.set(runId, state)
      const liveRun = store.getLiveRun(runId)
      if (liveRun.output.length > 0) state.mirror.write(liveRun.output)
      const nextState = state
      nextState.outputUnsubscribe = store.getPtyOutputBus().subscribe(runId, (chunk) => {
        nextState.mirror.write(chunk)
        for (const viewer of nextState.viewers.values()) {
          // Unpaired legacy IO consumers have no control/restore handshake.
          if (viewer.snapshotStarted || (!viewer.renderEvents && viewer.clientId === 'legacy')) {
            viewer.flowState?.enqueue(chunk)
          }
        }
      })
    }
    return state
  }

  const cleanupViewer = (runId: string, state: RunState, clientId: string) => {
    const viewer = state.viewers.get(clientId)
    if (!viewer || viewer.controlSocket || viewer.ioSocket) return
    state.viewers.delete(clientId)
    if (state.inputOwner === clientId) state.inputOwner = null
    maybeResumeRun(runId, state, clientId)
    cleanupRun(runId)
  }

  const startSnapshot = (runId: string, state: RunState, viewer: ViewerState) => {
    const socket = viewer.controlSocket
    if (
      !socket ||
      (!viewer.ioSocket && (viewer.renderEvents || viewer.clientId !== 'legacy')) ||
      viewer.snapshotStarted
    )
      return
    // Paired viewers attach both channels before taking the snapshot. Output before
    // this boundary belongs only to the snapshot; output after it belongs only
    // to the live stream, which the client buffers until restore completes.
    viewer.snapshotStarted = true
    const size = { ...state.size, render_events: viewer.renderEvents }
    void state.mirror
      .getSnapshot()
      .then((snapshot) => {
        sendWebSocketMessage(
          socket,
          serializeTerminalRestore(snapshot, size),
          `terminal ${runId} restore`
        )
      })
      .catch((error: unknown) => {
        sendWebSocketMessage(
          socket,
          serializeTerminalError(
            error instanceof Error ? error.message : 'Failed to restore terminal'
          ),
          `terminal ${runId} restore error`
        )
      })
  }

  const resizeRun = (runId: string, state: RunState, cols: number, rows: number) => {
    if (state.size.cols === cols && state.size.rows === rows) return
    // Only publish a new grid after the real PTY accepts it. Flush old output
    // before the resize event on the same IO channel, never across two sockets.
    store.resizeAgentRun(runId, cols, rows)
    state.size = { cols, rows }
    state.mirror.resize(cols, rows)
    for (const viewer of state.viewers.values()) {
      if (viewer.snapshotStarted) viewer.flowState?.resize(cols, rows)
    }
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
          if (controlSocket) sendWebSocketMessage(controlSocket, payload, `terminal ${runId} exit`)
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
    attachControl(runId, clientId, socket, _initialSize, renderEvents = false) {
      const state = getOrCreateState(runId)
      attachWebSocketErrorHandler(socket, `terminal ${runId} control`)
      const viewer = getOrCreateViewer(state, clientId)
      viewer.controlSocket = socket
      viewer.renderEvents = renderEvents
      // Legacy control-only observers restore on every connection; they do not
      // participate in the paired client's one-time stream boundary.
      if (!renderEvents && clientId === 'legacy') viewer.snapshotStarted = false
      startExitWatcher(runId, state)
      startSnapshot(runId, state, viewer)
      socket.on('message', (raw) => {
        try {
          const message = parseTerminalControlMessage(raw as Buffer | string)
          if (message.type === 'output_ack') viewer.flowState?.ack(message.bytes)
          if (message.type === 'resize') {
            if (rejectLegacyInteraction(state, viewer)) return
            if (!interactiveOwner(state) || interactiveOwner(state) === clientId) {
              resizeRun(runId, state, message.cols, message.rows)
              state.inputOwner = clientId
            }
          }
          if (message.type === 'stop') store.stopAgentRun(runId)
          if (message.type === 'restore_complete') return
        } catch (error) {
          sendWebSocketMessage(
            socket,
            serializeTerminalError(
              error instanceof Error ? error.message : 'Invalid control message'
            ),
            `terminal ${runId} control error`
          )
        }
      })
      socket.on('close', () => {
        if (viewer.controlSocket === socket) viewer.controlSocket = null
        cleanupViewer(runId, state, clientId)
      })
    },
    attachIo(runId, clientId, socket, _initialSize, renderEvents = false) {
      const state = getOrCreateState(runId)
      attachWebSocketErrorHandler(socket, `terminal ${runId} io`)
      const viewer = getOrCreateViewer(state, clientId)
      viewer.ioSocket = socket
      viewer.renderEvents = renderEvents
      viewer.flowState?.close()
      viewer.flowState = createTerminalOutputFlow(socket, {
        renderEvents,
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
      startSnapshot(runId, state, viewer)
      socket.on('message', (raw, isBinary) => {
        try {
          if (rejectLegacyInteraction(state, viewer)) return
          let input = normalizeTerminalInput(raw, isBinary)
          if (renderEvents) {
            const event = parseTerminalRenderInput(input.toString())
            input = event.data
            if (!event.userInput) {
              const replyOwner = interactiveOwner(state)
              if (replyOwner !== clientId) return
            } else if (input !== '\x1b[I' && input !== '\x1b[O') {
              resizeRun(runId, state, event.cols, event.rows)
              state.inputOwner = clientId
            }
          }
          store.writeRunInput(runId, input)
        } catch (error) {
          sendWebSocketMessage(
            socket,
            serializeTerminalError(
              error instanceof Error ? error.message : 'Failed to write terminal input'
            ),
            `terminal ${runId} input error`
          )
        }
      })
      socket.on('close', () => {
        // A replaced socket must not tear down its successor's output flow.
        if (viewer.ioSocket !== socket) return
        viewer.ioSocket = null
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
          viewer.ioSocket?.terminate()
          viewer.controlSocket?.terminate()
        }
        runStates.delete(runId)
      }
    },
  }
}
