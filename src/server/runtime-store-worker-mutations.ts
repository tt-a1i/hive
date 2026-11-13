import type { AgentSummary } from '../shared/types.js'
import type { RuntimeStore } from './runtime-store-contract.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'

interface RuntimeStoreWorkerMutationsOptions {
  addWorker: RuntimeStore['addWorker']
  configureAgentLaunch: RuntimeStore['configureAgentLaunch']
  deleteWorker: RuntimeStore['deleteWorker']
  runDataMutation: (mutation: () => void) => void
  services: RuntimeStoreServices
}

export const createRuntimeStoreWorkerMutations = ({
  addWorker,
  configureAgentLaunch,
  deleteWorker,
  runDataMutation,
  services,
}: RuntimeStoreWorkerMutationsOptions): Pick<
  RuntimeStore,
  'addWorkerWithLaunch' | 'deleteWorker'
> => ({
  addWorkerWithLaunch: (workspaceId, input, launchConfig) => {
    // Atomic spawn: create the worker AND its launch config together so a
    // failure can never persist a worker with no way to start it. The DB
    // transaction rolls back the row; the catch prunes the in-memory worker
    // that addWorker already pushed into the workspace record.
    let worker: AgentSummary | undefined
    try {
      runDataMutation(() => {
        worker = addWorker(workspaceId, input)
        configureAgentLaunch(workspaceId, worker.id, launchConfig)
      })
    } catch (error) {
      if (worker) {
        try {
          deleteWorker(workspaceId, worker.id)
        } catch {
          // The transaction already removed the DB row; this only prunes the
          // stale in-memory entry, which may already be gone.
        }
      }
      throw error
    }
    if (!worker) throw new Error('addWorkerWithLaunch produced no worker')
    return worker
  },
  deleteWorker: (workspaceId, workerId) =>
    services.removeWorkerCompletely(workspaceId, workerId, 'the worker was removed'),
})
