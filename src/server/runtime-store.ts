import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { AgentSummary, TeamListItem, WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import {
  type AgentLaunchConfigInput,
  createAgentRunStore,
  type PersistedAgentRun,
} from './agent-run-store.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentSessionStore } from './agent-session-store.js'
import { createMessageLogStore, type RecoveryMessage } from './message-log-store.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { initializeRuntimeDatabase } from './sqlite-schema.js'
import {
  createTeamOperations,
  type DispatchTaskInput,
  type ReportTaskInput,
} from './team-operations.js'
import { createUiAuth } from './ui-auth.js'
import { createWorkspaceStore, type WorkerInput, type WorkspaceRecord } from './workspace-store.js'

interface RuntimeStore {
  close: () => Promise<void>
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  listWorkspaces: () => WorkspaceSummary[]
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  recordUserInput: (workspaceId: string, orchestratorId: string, text: string) => void
  dispatchTask: (
    workspaceId: string,
    workerId: string,
    text: string,
    input?: DispatchTaskInput
  ) => void
  dispatchTaskByWorkerName: (
    workspaceId: string,
    workerName: string,
    text: string,
    input?: DispatchTaskInput
  ) => void
  reportTask: (workspaceId: string, workerId: string, input?: ReportTaskInput) => void
  listWorkers: (workspaceId: string) => TeamListItem[]
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getPtyOutputBus: () => PtyOutputBus
  listTerminalRuns: (workspaceId: string) => Array<{
    agent_id: string
    agent_name: string
    run_id: string
    status: string
  }>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  getLiveRun: (runId: string) => LiveAgentRun
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  peekAgentToken: (agentId: string) => string | undefined
  pauseTerminalRun: (runId: string) => void
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeTerminalRun: (runId: string) => void
  writeRunInput: (runId: string, text: string) => void
  getUiToken: () => string
  stopAgentRun: (runId: string) => void
  validateAgentToken: (agentId: string, token: string | undefined) => boolean
  validateUiToken: (token: string | undefined) => boolean
}

interface RuntimeStoreOptions {
  dataDir?: string
  agentManager?: AgentManager
}

interface StartAgentOptions {
  hivePort: string
}

export type { RuntimeStore }

export const createRuntimeStore = (options: RuntimeStoreOptions = {}): RuntimeStore => {
  const agentManager = options.agentManager
  const db = options.dataDir
    ? (() => {
        mkdirSync(options.dataDir, { recursive: true })
        const database = new Database(join(options.dataDir, 'runtime.sqlite'))
        initializeRuntimeDatabase(database)
        return database
      })()
    : undefined
  const messageLogStore = createMessageLogStore(db)
  const agentRunStore = createAgentRunStore(db)
  const agentSessionStore = createAgentSessionStore(db)
  const uiAuth = createUiAuth()

  messageLogStore.initialize()
  agentRunStore.initialize()
  const workspaceStore = createWorkspaceStore(db, messageLogStore.listMessageKinds())
  const agentRuntime = createAgentRuntime(
    agentManager,
    agentRunStore,
    agentSessionStore,
    (workspaceId, agentId) => {
      workspaceStore.markAgentStopped(workspaceId, agentId)
    }
  )
  const teamOps = createTeamOperations({
    agentRuntime,
    deleteMessage: messageLogStore.deleteMessage,
    insertMessage: messageLogStore.insertMessage,
    workspaceStore,
  })
  return {
    async close() {
      await agentRuntime.close()
      agentRunStore.close?.()
      db?.close()
    },
    createWorkspace: (path, name) => workspaceStore.createWorkspace(path, name),
    listWorkspaces: () => workspaceStore.listWorkspaces(),
    addWorker: (workspaceId, input) => workspaceStore.addWorker(workspaceId, input),
    recordUserInput: teamOps.recordUserInput,
    dispatchTask: teamOps.dispatchTask,
    dispatchTaskByWorkerName: teamOps.dispatchTaskByWorkerName,
    reportTask: teamOps.reportTask,
    listWorkers: (workspaceId) => workspaceStore.listWorkers(workspaceId),
    getWorkspaceSnapshot: (workspaceId) => workspaceStore.getWorkspaceSnapshot(workspaceId),
    getWorker: (workspaceId, workerId) => workspaceStore.getWorker(workspaceId, workerId),
    getAgent: (workspaceId, agentId) => workspaceStore.getAgent(workspaceId, agentId),
    getPtyOutputBus() {
      if (!agentManager) throw new Error('Agent manager is required for PTY output subscriptions')
      return agentManager.getOutputBus()
    },
    listTerminalRuns(workspaceId) {
      return workspaceStore.getWorkspaceSnapshot(workspaceId).agents.flatMap((agent) => {
        const run = agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (!run) return []
        return [
          { agent_id: agent.id, agent_name: agent.name, run_id: run.runId, status: run.status },
        ]
      })
    },
    configureAgentLaunch(workspaceId, agentId, input) {
      workspaceStore.getAgent(workspaceId, agentId)
      agentRuntime.configureAgentLaunch(workspaceId, agentId, input)
    },
    async startAgent(workspaceId, agentId, input) {
      workspaceStore.getAgent(workspaceId, agentId)
      workspaceStore.markAgentStarted(workspaceId, agentId)
      try {
        const run = await agentRuntime.startAgent(
          workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
          agentId,
          input
        )
        if (run.status === 'error') {
          workspaceStore.markAgentStopped(workspaceId, agentId)
        }
        return run
      } catch (error) {
        workspaceStore.markAgentStopped(workspaceId, agentId)
        throw error
      }
    },
    getLiveRun: (runId) => agentRuntime.getLiveRun(runId),
    getActiveRunByAgentId: (workspaceId, agentId) =>
      agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
    listAgentRuns: (agentId) => agentRuntime.listAgentRuns(agentId),
    listMessagesForRecovery: (workspaceId, sinceMs) =>
      messageLogStore.listMessagesForRecovery(workspaceId, sinceMs),
    peekAgentToken: (agentId) => agentRuntime.peekAgentToken(agentId),
    pauseTerminalRun: (runId) => agentRuntime.pauseRun(runId),
    resizeAgentRun: (runId, cols, rows) => agentRuntime.resizeAgentRun(runId, cols, rows),
    resumeTerminalRun: (runId) => agentRuntime.resumeRun(runId),
    writeRunInput(runId, text) {
      if (!agentManager) throw new Error('Agent manager is required for PTY stdin writes')
      agentManager.writeInput(runId, text)
    },
    getUiToken: () => uiAuth.getToken(),
    stopAgentRun: (runId) => agentRuntime.stopAgentRun(runId),
    validateAgentToken: (agentId, token) => agentRuntime.validateAgentToken(agentId, token),
    validateUiToken: (token) => uiAuth.validate(token),
  }
}
