import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorkerRole } from '../shared/types.js'
import type { UiLanguage } from '../shared/ui-language.js'
import type { PickFolderResponse } from './fs-pick-folder.js'
import type {
  OpenCommandResult,
  OpenWorkspaceInput as OpenWorkspaceServiceInput,
} from './open-target-commands.js'
import type { RuntimeStore } from './runtime-store.js'
import type { TasksFileService } from './tasks-file.js'
import type { VersionService } from './version-service.js'

export interface SendTaskBody {
  related_to_dispatch_id?: string
  hive_port?: string
  project_id: string
  from_agent_id: string
  token?: string
  to: string
  text: string
}

export interface SpawnAgentBody {
  hive_port?: string
  project_id: string
  from_agent_id: string
  token?: string
  role?: string
  name?: string
  cli?: string
  /** Opt-in: auto-dismiss the worker after its next dispatch report. Default
   *  false → persistent member (lives until explicit `team dismiss`). */
  ephemeral?: boolean
  locale?: UiLanguage
}

export interface DismissAgentBody {
  hive_port?: string
  project_id: string
  from_agent_id: string
  token?: string
  name: string
}

export interface WorkflowRunBody {
  hive_port?: string
  project_id: string
  from_agent_id: string
  token?: string
  source: string
  name?: string
  args?: unknown
}

export interface WorkflowControlBody {
  project_id: string
  from_agent_id: string
  token?: string
  run_id: string
}

export interface WorkflowScheduleBody {
  project_id: string
  from_agent_id: string
  token?: string
  source: string
  name: string
  cron: string
  args?: unknown
}

export interface ReportTaskBody {
  ack_batch_id?: string
  seen_seq?: number
  dispatch_id?: string
  project_id: string
  from_agent_id: string
  token?: string
  result: string
  status?: 'success' | 'failed'
  artifacts?: unknown[]
}

export interface GoalReportBody {
  artifacts?: unknown[]
  goal_id?: string
  project_id: string
  from_agent_id: string
  token?: string
  result?: string
  status?: string
}

export interface CancelTaskBody {
  dispatch_id?: string
  project_id: string
  from_agent_id: string
  token?: string
  reason?: string
}

export interface ExternalGoalStartBody {
  workspace_id?: string
  goal?: string
  context?: unknown
  timeout_hint_ms?: number
  source?: string
}

export interface ExternalGoalWaitBody {
  goal_id?: string
  cursor?: number
  timeout_ms?: number
}

export interface ExternalGoalContinueBody {
  goal_id?: string
  message?: string
  context?: unknown
}

export interface ExternalGoalCancelBody {
  goal_id?: string
  reason?: string
}

export interface CreateWorkspaceBody {
  controller_mode?: 'internal' | 'codex_app'
  path: string
  name: string
  /** Default true. When false, skip orchestrator PTY spawn after creation. */
  autostart_orchestrator?: boolean
  /** Optional command preset. With startup_command, this selects the CLI interaction driver. */
  command_preset_id?: string | null
  /** Optional full startup command. When set, it overrides the executable only. */
  startup_command?: string | null
  /** Browser UI language at creation time; stored per workspace for server-generated prompts. */
  ui_language?: UiLanguage
}

export interface CreateWorkerBody {
  autostart?: boolean
  avatar?: string | null
  command_preset_id?: string | null
  description?: string
  name: string
  role: WorkerRole
  /** Optional full startup command. When set, it overrides the executable only. */
  startup_command?: string | null
  /** Browser UI language for server-generated fallback descriptions. */
  ui_language?: UiLanguage
}

export interface UserInputBody {
  text: string
}

export interface ConfigureAgentLaunchBody {
  command: string
  args?: string[]
  command_preset_id?: string | null
}

export interface OpenWorkspaceBody {
  target_id: string
}

export type OpenWorkspaceService = (input: OpenWorkspaceServiceInput) => Promise<OpenCommandResult>

export interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  store: RuntimeStore
  tasksFileService: TasksFileService
  pickFolderService: () => Promise<PickFolderResponse>
  openWorkspaceService: OpenWorkspaceService
  versionService: VersionService
  params: Record<string, string>
}

export interface RouteDefinition {
  method: string
  path: string
  handler: (context: RouteContext) => Promise<void> | void
}

export type { WorkerRole }
