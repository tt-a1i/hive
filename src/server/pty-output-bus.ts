type OutputListener = (chunk: string) => void

export interface PtyOutputBus {
  clear: (runId: string) => void
  notifyExit?: (runId: string) => void
  subscribeExit?: (runId: string, listener: () => void) => () => void
  remove?: (runId: string) => void
  subscribeRemoval?: (runId: string, listener: () => void) => () => void
  publish: (runId: string, chunk: string) => void
  subscribe: (runId: string, listener: OutputListener) => () => void
}

export const createPtyOutputBus = (): PtyOutputBus => {
  const exitListeners = new Map<string, Set<() => void>>()
  const removalListeners = new Map<string, Set<() => void>>()
  const listenersByRunId = new Map<string, Set<OutputListener>>()

  const getListeners = (runId: string) => {
    let listeners = listenersByRunId.get(runId)
    if (!listeners) {
      listeners = new Set<OutputListener>()
      listenersByRunId.set(runId, listeners)
    }
    return listeners
  }

  return {
    clear(runId) {
      listenersByRunId.delete(runId)
    },
    notifyExit(runId) {
      const listeners = exitListeners.get(runId)
      if (listeners) for (const listener of [...listeners]) listener()
      exitListeners.delete(runId)
    },
    subscribeExit(runId, listener) {
      let listeners = exitListeners.get(runId)
      if (!listeners) {
        listeners = new Set()
        exitListeners.set(runId, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) exitListeners.delete(runId)
      }
    },
    remove(runId) {
      const listeners = removalListeners.get(runId)
      if (listeners) for (const listener of [...listeners]) listener()
      removalListeners.delete(runId)
      exitListeners.delete(runId)
      listenersByRunId.delete(runId)
    },
    subscribeRemoval(runId, listener) {
      let listeners = removalListeners.get(runId)
      if (!listeners) {
        listeners = new Set()
        removalListeners.set(runId, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) removalListeners.delete(runId)
      }
    },
    publish(runId, chunk) {
      const listeners = listenersByRunId.get(runId)
      if (!listeners) return
      for (const listener of listeners) listener(chunk)
    },
    subscribe(runId, listener) {
      const listeners = getListeners(runId)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) listenersByRunId.delete(runId)
      }
    },
  }
}
