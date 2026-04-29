import { describe, expect, test, vi } from 'vitest'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTeamOperations } from '../../src/server/team-operations.js'

describe('team atomicity', () => {
  test('dispatchTask does not bump pending count when message insert fails before PTY write', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const insertMessage = vi.fn(() => {
      throw new Error('insert message failed')
    })
    const deleteMessage = vi.fn()
    const writeSendPrompt = vi.fn()
    const markTaskDispatched = vi.fn()
    const ops = createTeamOperations({
      agentRuntime: {
        writeSendPrompt,
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      deleteMessage,
      insertMessage,
      workspaceStore: {
        getAgent: store.getAgent,
        getWorker: store.getWorker,
        getWorkerByName: (workspaceId: string, workerName: string) => {
          const worker = store
            .getWorkspaceSnapshot(workspaceId)
            .agents.find((agent) => agent.name === workerName && agent.role !== 'orchestrator')
          if (!worker) {
            throw new Error(`Worker not found: ${workerName}`)
          }
          return worker
        },
        markTaskDispatched,
        markTaskReported: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/insert message failed/)

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 0,
        status: 'stopped',
      })
    )
    expect(store.listMessagesForRecovery(workspace.id, 0)).toEqual([])
    expect(writeSendPrompt).not.toHaveBeenCalled()
    expect(insertMessage).toHaveBeenCalledTimes(1)
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(markTaskDispatched).not.toHaveBeenCalled()
  })

  test('reportTask with requireActiveRun throws and leaves pending count + messages untouched when orch run is absent', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    // Simulate PTY already running so dispatchTask can promote to working.
    store.getWorker(workspace.id, worker.id).status = 'idle'

    // Dispatch first so pendingTaskCount rises to 1 — gives reportTask something to decrement.
    store.dispatchTask(workspace.id, worker.id, 'Implement login')
    const beforeMessages = store.listMessagesForRecovery(workspace.id, 0).length

    // Now request a report that REQUIRES an active orchestrator run. There is none,
    // so writeReportPrompt will throw. Nothing downstream (insertMessage, markTaskReported)
    // must run.
    expect(() =>
      store.reportTask(workspace.id, worker.id, {
        status: 'success',
        text: 'Done',
        requireActiveRun: true,
      })
    ).toThrow()

    // pending count stays at 1 (no decrement), messages list unchanged.
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 1,
        status: 'working',
      })
    )
    expect(store.listMessagesForRecovery(workspace.id, 0).length).toBe(beforeMessages)
  })
})
