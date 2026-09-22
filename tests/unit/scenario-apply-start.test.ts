import { describe, expect, test, vi } from 'vitest'
import { applyAndStartScenario } from '../../src/server/routes-scenarios.js'
import type { RuntimeStore } from '../../src/server/runtime-store.js'
import { getScenarioPreset } from '../../src/server/scenario-presets.js'
import type { AgentSummary, WorkerRole } from '../../src/shared/types.js'

const createScenarioStore = () => {
  const workers: AgentSummary[] = []
  const startResolvers: Array<(value: Awaited<ReturnType<RuntimeStore['startAgent']>>) => void> = []

  const startAgent = vi.fn((_workspaceId: string, agentId: string, _input: { hivePort: string }) =>
    new Promise<Awaited<ReturnType<RuntimeStore['startAgent']>>>((resolve) => {
      startResolvers.push(resolve)
    }).then((run) => ({ ...run, agentId }))
  )
  const deliverUserInput = vi.fn<RuntimeStore['deliverUserInput']>(async () => {})

  const store = {
    settings: {
      getCommandPreset: (id: string) => ({ id, command: id, args: [], env: {} }),
    },
    peekAgentLaunchConfig: (_workspaceId: string, agentId: string) =>
      agentId.endsWith(':orchestrator')
        ? { command: 'codex', commandPresetId: 'codex', args: [] }
        : undefined,
    listWorkers: () => workers,
    addWorkerWithLaunch: (
      workspaceId: string,
      input: { name: string; role: WorkerRole; description?: string },
      _launchConfig: unknown
    ) => {
      const worker: AgentSummary = {
        id: `worker-${workers.length + 1}`,
        workspaceId,
        name: input.name,
        description: input.description ?? input.role,
        role: input.role,
        status: 'stopped',
        pendingTaskCount: 0,
      }
      workers.push(worker)
      return worker
    },
    startAgent,
    deliverUserInput,
  } as unknown as RuntimeStore

  const resolveStarts = () => {
    for (const [index, resolve] of startResolvers.entries()) {
      resolve({
        agentId: `worker-${index + 1}`,
        exitCode: null,
        output: '',
        pid: index + 1,
        runId: `run-${index + 1}`,
        startedAt: Date.now(),
        status: 'running',
      })
    }
  }

  return { deliverUserInput, resolveStarts, startAgent, store, workers }
}

describe('applyAndStartScenario', () => {
  test('starts every created scenario member before injecting the kickoff', async () => {
    const { deliverUserInput, resolveStarts, startAgent, store } = createScenarioStore()
    const scenario = getScenarioPreset('build_review_test')
    if (!scenario) throw new Error('missing scenario preset')

    const promise = applyAndStartScenario(
      store,
      'workspace-1',
      scenario,
      'Ship the CSV export',
      '4173',
      () => true,
      'en'
    )

    await Promise.resolve()

    expect(startAgent).toHaveBeenCalledTimes(3)
    expect(startAgent).toHaveBeenNthCalledWith(1, 'workspace-1', 'worker-1', { hivePort: '4173' })
    expect(startAgent).toHaveBeenNthCalledWith(2, 'workspace-1', 'worker-2', { hivePort: '4173' })
    expect(startAgent).toHaveBeenNthCalledWith(3, 'workspace-1', 'worker-3', { hivePort: '4173' })
    expect(deliverUserInput).not.toHaveBeenCalled()

    resolveStarts()
    const started = await promise

    expect(started.map((worker) => worker.start.run_id)).toEqual(['run-1', 'run-2', 'run-3'])
    expect(deliverUserInput).toHaveBeenCalledTimes(1)
    expect(deliverUserInput.mock.calls[0]?.[2]).toContain('Ship the CSV export')
    for (const worker of started) {
      expect(deliverUserInput.mock.calls[0]?.[2]).toContain(worker.name)
    }
  })
})
