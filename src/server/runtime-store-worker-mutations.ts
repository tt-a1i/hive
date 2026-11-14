import type { RuntimeStore } from './runtime-store-contract.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'

interface RuntimeStoreWorkerMutationsOptions {
  runDataMutation: <T>(mutation: () => T) => T
  services: RuntimeStoreServices
}

export const createRuntimeStoreWorkerMutations = ({
  runDataMutation,
  services,
}: RuntimeStoreWorkerMutationsOptions): Pick<
  RuntimeStore,
  'addWorkerWithLaunch' | 'deleteWorker'
> => ({
  addWorkerWithLaunch: (workspaceId, input, launchConfig) => {
    const worker = runDataMutation(() => {
      const created = services.workspaceStore.addWorker(workspaceId, input, true)
      services.agentRunStore.saveLaunchConfig(workspaceId, created.id, launchConfig)
      return created
    })
    services.workspaceStore.publishWorker(workspaceId, worker)
    services.agentRuntime.invalidateAgentLaunchConfig(workspaceId, worker.id)
    return worker
  },
  deleteWorker: (workspaceId, workerId) =>
    services.removeWorkerCompletely(workspaceId, workerId, 'the worker was removed'),
})
