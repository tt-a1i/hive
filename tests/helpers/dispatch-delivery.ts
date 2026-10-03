import { expect } from 'vitest'
import type { createRuntimeStore } from '../../src/server/runtime-store.js'

type RuntimeStore = ReturnType<typeof createRuntimeStore>

// Dispatch acceptance is asynchronous. Reporting fixtures must wait for the
// real worker delivery, rather than treating a queued row as completed work.
export const waitForDispatchDelivery = async (
  store: RuntimeStore,
  workspaceId: string,
  dispatchId: string
) => {
  await expect
    .poll(
      () => store.listDispatches(workspaceId).find((item) => item.id === dispatchId)?.deliveredAt,
      { timeout: 8000 }
    )
    .toEqual(expect.any(Number))
}

export const startPassiveTestWorker = async (
  store: RuntimeStore,
  workspaceId: string,
  workerId: string
) => {
  store.configureAgentLaunch(workspaceId, workerId, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  await store.startAgent(workspaceId, workerId, { hivePort: '4010' })
  await store.getActiveRunByAgentId(workspaceId, workerId)?.postStartInputReady
}
