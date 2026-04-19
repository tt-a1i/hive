type OutputListener = (chunk: string) => void

export interface PtyOutputBus {
  clear: (runId: string) => void
  publish: (runId: string, chunk: string) => void
  subscribe: (runId: string, listener: OutputListener) => () => void
}

export const createPtyOutputBus = (): PtyOutputBus => {
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
