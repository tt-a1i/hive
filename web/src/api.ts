import type {
  AgentSummary,
  TeamListItem,
  WorkerRole,
  WorkspaceSummary,
} from '../../src/shared/types.js'

export const listWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await fetch('/api/workspaces')

  if (!response.ok) {
    throw new Error('Failed to load workspaces')
  }

  return (await response.json()) as WorkspaceSummary[]
}

export const createWorkspace = async (
  input: Pick<WorkspaceSummary, 'name' | 'path'>
): Promise<WorkspaceSummary> => {
  const response = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error('Failed to create workspace')
  }

  return (await response.json()) as WorkspaceSummary
}

export const listWorkers = async (workspaceId: string): Promise<TeamListItem[]> => {
  const response = await fetch(`/api/workspaces/${workspaceId}/team`)

  if (!response.ok) {
    throw new Error('Failed to load workers')
  }

  return (await response.json()) as TeamListItem[]
}

export const createWorker = async (
  workspaceId: string,
  input: Pick<AgentSummary, 'name'> & { role: WorkerRole }
): Promise<TeamListItem> => {
  const response = await fetch(`/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error('Failed to create worker')
  }

  return (await response.json()) as TeamListItem
}
