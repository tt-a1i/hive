import type { AgentSummary, WorkerRole } from '../shared/types.js'
import type { WorkspaceRecord } from './workspace-store-contract.js'
import { getStatusFromPendingCount, isWorkerAgent } from './workspace-store-support.js'

type WorkspaceMap = Map<string, WorkspaceRecord>

const getWorkspaceRecord = (workspaces: WorkspaceMap, workspaceId: string) => {
  const workspace = workspaces.get(workspaceId)
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
  return workspace
}

export const getAgentRecord = (workspaces: WorkspaceMap, workspaceId: string, agentId: string) => {
  const agent = getWorkspaceRecord(workspaces, workspaceId).agents.find(
    (item) => item.id === agentId
  )
  if (!agent) throw new Error(`Agent not found: ${agentId}`)
  return agent
}

export const getWorkerRecord = (
  workspaces: WorkspaceMap,
  workspaceId: string,
  workerId: string
) => {
  const worker = getAgentRecord(workspaces, workspaceId, workerId)
  if (!isWorkerAgent(worker)) throw new Error(`Worker not found: ${workerId}`)
  return worker as AgentSummary & { role: WorkerRole }
}

export const getWorkerByNameRecord = (
  workspaces: WorkspaceMap,
  workspaceId: string,
  workerName: string
) => {
  const worker = getWorkspaceRecord(workspaces, workspaceId).agents.find(
    (item) => item.name === workerName && isWorkerAgent(item)
  )
  if (!worker) throw new Error(`Worker not found: ${workerName}`)
  return worker
}

export const markAgentStarted = (
  workspaces: WorkspaceMap,
  workspaceId: string,
  agentId: string
) => {
  const pendingTaskCount = getAgentRecord(workspaces, workspaceId, agentId).pendingTaskCount
  getAgentRecord(workspaces, workspaceId, agentId).status =
    getStatusFromPendingCount(pendingTaskCount)
}

export const markAgentStopped = (
  workspaces: WorkspaceMap,
  workspaceId: string,
  agentId: string
) => {
  getAgentRecord(workspaces, workspaceId, agentId).status = 'stopped'
}

export const markTaskDispatched = (
  workspaces: WorkspaceMap,
  workspaceId: string,
  workerId: string
) => {
  const worker = getWorkerRecord(workspaces, workspaceId, workerId)
  worker.pendingTaskCount += 1
  worker.status = getStatusFromPendingCount(worker.pendingTaskCount)
}

export const markTaskReported = (
  workspaces: WorkspaceMap,
  workspaceId: string,
  workerId: string
) => {
  const worker = getWorkerRecord(workspaces, workspaceId, workerId)
  worker.pendingTaskCount = Math.max(0, worker.pendingTaskCount - 1)
  if (worker.status !== 'stopped')
    worker.status = getStatusFromPendingCount(worker.pendingTaskCount)
}
