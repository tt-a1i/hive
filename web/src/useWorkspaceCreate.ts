import { useCallback, useState } from 'react'
import type { WorkspaceSummary } from '../../src/shared/types.js'
import {
  type CreateWorkspaceResponse,
  createWorkspace,
  type OrchestratorStartResult,
} from './api.js'
import type { WorkspaceCreateInput } from './workspace/workspace-create-input.js'

interface UseWorkspaceCreateInput {
  hivePort: string
  /** Mutate workspaces list when create succeeds. */
  onWorkspaceCreated: (workspace: WorkspaceSummary) => void
}

interface UseWorkspaceCreateOutput {
  /** workspaceId → sticky autostart error (cleared on Retry). */
  orchestratorAutostartErrors: Record<string, string | null>
  recordOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  createNewWorkspace: (input: WorkspaceCreateInput) => Promise<CreateWorkspaceResponse>
}

/**
 * Owns the per-workspace orchestrator autostart error state. This is sticky:
 * the error remains until the user clicks Retry (or a successful manual start
 * happens elsewhere), so the OrchestratorPane can keep showing failed-state.
 */
export const useWorkspaceCreate = ({
  hivePort,
  onWorkspaceCreated,
}: UseWorkspaceCreateInput): UseWorkspaceCreateOutput => {
  const [orchestratorAutostartErrors, setErrors] = useState<Record<string, string | null>>({})

  const recordOrchestratorResult = useCallback(
    (workspaceId: string, result: OrchestratorStartResult) => {
      setErrors((current) => ({ ...current, [workspaceId]: result.ok ? null : result.error }))
    },
    []
  )

  const createNewWorkspace = useCallback(
    async (input: WorkspaceCreateInput) => {
      const response = await createWorkspace({
        name: input.name,
        path: input.path,
        autostart_orchestrator: true,
        command_preset_id: input.commandPresetId,
        hive_port: hivePort,
      })
      onWorkspaceCreated({ id: response.id, name: response.name, path: response.path })
      recordOrchestratorResult(response.id, response.orchestrator_start)
      return response
    },
    [hivePort, onWorkspaceCreated, recordOrchestratorResult]
  )

  return { orchestratorAutostartErrors, recordOrchestratorResult, createNewWorkspace }
}
