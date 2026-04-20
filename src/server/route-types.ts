import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WorkerRole } from '../shared/types.js'
import type { RuntimeStore } from './runtime-store.js'
import type { TasksFileService } from './tasks-file.js'

export interface SendTaskBody {
  project_id: string
  from_agent_id: string
  token?: string
  to: string
  text: string
}

export interface ReportTaskBody {
  project_id: string
  from_agent_id: string
  token?: string
  result: string
  status: string
  artifacts: unknown[]
}

export interface CreateWorkspaceBody {
  path: string
  name: string
}

export interface CreateWorkerBody {
  description?: string
  name: string
  role: WorkerRole
}

export interface UserInputBody {
  text: string
}

export interface LaunchAgentBody {
  hive_port: string
}

export interface ConfigureAgentLaunchBody {
  command: string
  args?: string[]
  command_preset_id?: string | null
}

export interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  store: RuntimeStore
  tasksFileService: TasksFileService
  params: Record<string, string>
}

export interface RouteDefinition {
  method: string
  path: string
  handler: (context: RouteContext) => Promise<void> | void
}

export type { WorkerRole }
