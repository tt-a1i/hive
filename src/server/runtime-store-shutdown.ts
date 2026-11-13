import type { createRuntimeStoreServices } from './runtime-store-helpers.js'
import type { createRuntimeStoreWorkflowRuntime } from './runtime-store-workflows.js'

type Closeable = { close: () => Promise<void> }

/** Own the shutdown order: stop admissions, drain users of SQLite, then close it. */
export const createRuntimeStoreShutdown = (
  services: Pick<
    ReturnType<typeof createRuntimeStoreServices>,
    'markRuntimeClosing' | 'dispatchMessageOps'
  >,
  lifecycle: Closeable,
  getWorkflows: () => ReturnType<typeof createRuntimeStoreWorkflowRuntime> | undefined
): (() => Promise<void>) => {
  let closing: Promise<void> | undefined
  return () =>
    (closing ??= (async () => {
      services.markRuntimeClosing()
      services.dispatchMessageOps.notifyDispatchQuestionChange()
      const workflows = getWorkflows()
      workflows?.scheduler.close()
      await workflows?.runner.close()
      await lifecycle.close()
    })())
}
