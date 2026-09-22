import type { AgentSummary } from '../shared/types.js'
import { controllerReceiptPendingSql } from './controller-receipt-policy.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { ConflictError } from './http-errors.js'
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
  deleteWorker: (workspaceId, workerId) => {
    if (
      services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.controller_mode ===
      'codex_app'
    ) {
      const unresolved = services.db
        .prepare(`SELECT 1 FROM dispatches d
        LEFT JOIN report_outbox o ON COALESCE(o.source_dispatch_id,o.dispatch_id) = d.id
        WHERE d.workspace_id = ? AND d.to_agent_id = ? AND d.workflow_run_id IS NULL
          AND (d.status IN ('queued','submitted') OR (o.id IS NOT NULL AND ${controllerReceiptPendingSql})) LIMIT 1`)
        .get(workspaceId, workerId)
      if (unresolved)
        throw new ConflictError(
          'Cancel pending tasks and acknowledge member reports before removing this member'
        )
    }
    const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
    const droppedNoticeTargets = new Set<string>()
    let cancelledDelegations: DispatchRecord[] = []
    runDataMutation(() => {
      for (const dispatch of services.dispatchLedgerStore.listOpenWorkspaceDispatches(
        workspaceId
      )) {
        if (
          dispatch.toAgentId === workerId &&
          dispatch.workflowRunId === null &&
          (dispatch.status === 'queued' || dispatch.status === 'submitted')
        ) {
          services.reportOutbox.deletePendingForDispatch(dispatch.id)
        }
      }
      for (const targetAgentId of services.teamOps.notifyIssuersOfDroppedDispatches(
        workspaceId,
        workerId,
        'the worker was removed'
      )) {
        droppedNoticeTargets.add(targetAgentId)
      }
      cancelledDelegations = services.dispatchLedgerStore.deleteWorkerDispatches(
        workspaceId,
        workerId
      )
      services.workspaceStore.deleteWorker(workspaceId, workerId)
    })
    services.teamOps.settleCancelledDelegations(cancelledDelegations)
    for (const targetAgentId of droppedNoticeTargets) {
      services.teamOps.drainReportOutbox(workspaceId, targetAgentId)
    }
    services.agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
    if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
  },
})
