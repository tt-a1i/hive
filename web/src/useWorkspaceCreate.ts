import { useCallback, useState } from 'react'
import type { WorkspaceSummary } from '../../src/shared/types.js'
import {
  type CreateWorkspaceResponse,
  createWorkspace,
  type OrchestratorStartResult,
} from './api.js'
import { useI18n } from './i18n.js'
import type { WorkspaceCreateInput } from './workspace/workspace-create-input.js'

interface UseWorkspaceCreateInput {
  /** Mutate workspaces list when create succeeds. */
  onWorkspaceCreated: (workspace: WorkspaceSummary) => void
  /** Surface server / network errors so the caller can toast them. */
  onError?: (message: string) => void
  onOrchestratorRunStarted?: (workspaceId: string, runId: string) => void
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
  onWorkspaceCreated,
  onError,
  onOrchestratorRunStarted,
}: UseWorkspaceCreateInput): UseWorkspaceCreateOutput => {
  const { language } = useI18n()
  const [orchestratorAutostartErrors, setErrors] = useState<Record<string, string | null>>({})

  const recordOrchestratorResult = useCallback(
    (workspaceId: string, result: OrchestratorStartResult) => {
      setErrors((current) => ({ ...current, [workspaceId]: result.ok ? null : result.error }))
      if (result.ok && result.run_id) onOrchestratorRunStarted?.(workspaceId, result.run_id)
    },
    [onOrchestratorRunStarted]
  )

  const createNewWorkspace = useCallback(
    async (input: WorkspaceCreateInput) => {
      try {
        const response = await createWorkspace({
          name: input.name,
          path: input.path,
          autostart_orchestrator: true,
          command_preset_id: input.commandPresetId,
          startup_command: input.startupCommand ?? null,
          ui_language: language,
        })
        recordOrchestratorResult(response.id, response.orchestrator_start)
        onWorkspaceCreated({
          id: response.id,
          name: response.name,
          path: response.path,
        })
        return response
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create workspace'
        onError?.(message)
        throw error
      }
    },
    [language, onWorkspaceCreated, onError, recordOrchestratorResult]
  )

  return {
    orchestratorAutostartErrors,
    recordOrchestratorResult,
    createNewWorkspace,
  }
}
