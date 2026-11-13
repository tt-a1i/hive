import { afterEach, expect, test, vi } from 'vitest'
import type { LiveAgentRun } from '../../src/server/agent-runtime-types.js'
import { createDispatchMessageOutbox } from '../../src/server/dispatch-message-outbox.js'
import {
  createRuntimeStoreLifecycle,
  createRuntimeStoreServices,
} from '../../src/server/runtime-store-helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})
const setup = async () => {
  const services = createRuntimeStoreServices()
  cleanups.push(() => createRuntimeStoreLifecycle({ services }).close())
  const workspace = services.workspaceStore.createWorkspace('/tmp/hive-outbox-retry', 'Retry')
  const worker = services.workspaceStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  const dispatch = await services.teamOps.dispatchTask(workspace.id, worker.id, 'Task')
  const message = services.dispatchMessageOps.sendDispatchMessage(
    workspace.id,
    `${workspace.id}:orchestrator`,
    {
      dispatchId: dispatch.id,
      kind: 'note',
      text: 'Please cover retry',
    }
  )
  vi.spyOn(services.agentRuntime, 'getActiveRunByAgentId').mockReturnValue({
    runId: 'retry-run',
  } as LiveAgentRun)
  const outbox = createDispatchMessageOutbox({
    messages: services.dispatchMessageStore,
    runtime: services.agentRuntime,
    isClosing: services.isRuntimeClosing,
  })
  cleanups.push(async () => outbox.close())
  vi.useFakeTimers()
  return { services, workspace, worker, dispatch, message, outbox }
}

test('retries transient delivery without an explicit drain and clears the persisted error', async () => {
  const { services, workspace, worker, message, outbox } = await setup()
  let attempts = 0
  const delivered: string[] = []
  vi.spyOn(services.agentRuntime, 'deliverSystemMessageToAgent').mockImplementation(
    async (_ws, _agent, payload) => {
      if (++attempts < 3) throw new Error('temporary delivery failure')
      delivered.push(typeof payload === 'function' ? (payload() ?? '') : payload)
    }
  )
  outbox(workspace.id, worker.id)
  await vi.advanceTimersByTimeAsync(0)
  expect(attempts).toBe(1)
  await vi.advanceTimersByTimeAsync(249)
  expect(attempts).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(attempts).toBe(2)
  await vi.advanceTimersByTimeAsync(499)
  expect(attempts).toBe(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(attempts).toBe(3)
  expect(delivered[0]).toContain('Please cover retry')
  expect(services.dispatchMessageStore.getMessage(workspace.id, message.id)).toMatchObject({
    deliveryState: 'delivered',
    deliveryError: null,
  })
})

test('caps automatic retries but permits a later explicit drain', async () => {
  const { services, workspace, worker, message, outbox } = await setup()
  let attempts = 0
  let failing = true
  vi.spyOn(services.agentRuntime, 'deliverSystemMessageToAgent').mockImplementation(async () => {
    attempts++
    if (failing) throw new Error('delivery unavailable')
  })
  outbox(workspace.id, worker.id)
  await vi.runAllTimersAsync()
  expect(attempts).toBe(3)
  expect(vi.getTimerCount()).toBe(0)
  expect(services.dispatchMessageStore.getMessage(workspace.id, message.id)?.deliveryState).toBe(
    'queued'
  )
  failing = false
  outbox(workspace.id, worker.id)
  await vi.runAllTimersAsync()
  expect(attempts).toBe(4)
  expect(services.dispatchMessageStore.getMessage(workspace.id, message.id)?.deliveryState).toBe(
    'delivered'
  )
})

test.each(['cancel', 'close', 'stop'] as const)('retires retries after %s', async (action) => {
  const { services, workspace, worker, dispatch, message, outbox } = await setup()
  let attempts = 0
  vi.spyOn(services.agentRuntime, 'deliverSystemMessageToAgent').mockImplementation(async () => {
    attempts++
    throw new Error('delivery unavailable')
  })
  outbox(workspace.id, worker.id)
  await vi.advanceTimersByTimeAsync(0)
  expect(attempts).toBe(1)
  if (action === 'cancel')
    services.dispatchLedgerStore.markCancelled({
      workspaceId: workspace.id,
      dispatchId: dispatch.id,
      reason: 'superseded',
    })
  if (action === 'close') outbox.close()
  if (action === 'stop')
    vi.mocked(services.agentRuntime.getActiveRunByAgentId).mockReturnValue(undefined)
  await vi.runAllTimersAsync()
  expect(attempts).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
  expect(services.dispatchMessageStore.getMessage(workspace.id, message.id)?.deliveryState).toBe(
    action === 'cancel' ? 'cancelled' : 'queued'
  )
})

test('runtime shutdown clears its pending retry before SQLite is closed', async () => {
  const { services, workspace, worker, message } = await setup()
  let attempts = 0
  vi.spyOn(services.agentRuntime, 'deliverSystemMessageToAgent').mockImplementation(async () => {
    attempts++
    throw new Error('delivery unavailable')
  })
  services.dispatchMessageOps.drainDispatchMessageOutbox(workspace.id, worker.id)
  await vi.advanceTimersByTimeAsync(0)
  expect(attempts).toBe(1)
  expect(vi.getTimerCount()).toBe(1)
  services.markRuntimeClosing()
  expect(vi.getTimerCount()).toBe(0)
  await vi.runAllTimersAsync()
  expect(attempts).toBe(1)
  expect(services.dispatchMessageStore.getMessage(workspace.id, message.id)?.deliveryState).toBe(
    'queued'
  )
})
