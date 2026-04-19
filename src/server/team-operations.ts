import type { AgentRuntime } from './agent-runtime.js'
import type { MessageLogRecord } from './message-log-store.js'
import {
  createReportMessage,
  createSendMessage,
  createUserInputMessage,
} from './runtime-message-builders.js'
import type { WorkspaceStore } from './workspace-store.js'

export interface TeamOperationsInput {
  agentRuntime: AgentRuntime
  insertMessage: (record: MessageLogRecord) => void
  workspaceStore: WorkspaceStore
}

export interface DispatchTaskInput {
  fromAgentId?: string
}

export interface ReportTaskInput {
  artifacts?: string[]
  requireActiveRun?: boolean
  status?: string
  text?: string
}

export const createTeamOperations = ({
  agentRuntime,
  insertMessage,
  workspaceStore,
}: TeamOperationsInput) => {
  // Ordering note: PTY write first, then DB, then in-memory pending++.
  // Rationale: writeSendPrompt is the only step that can fail with a user-visible 409
  // (PtyInactiveError); putting it first means failure leaves DB + counters untouched.
  // Known limitation (R1.1 option B): if `insertMessage` throws after pty.write succeeded,
  // the worker received the prompt but the dispatch record is lost. MVP accepts this —
  // post-MVP should wrap insertMessage + markTaskDispatched in a real SQLite transaction
  // (with delete-message compensation) or introduce a two-phase queue.
  const dispatchTask = (
    workspaceId: string,
    workerId: string,
    text: string,
    input: DispatchTaskInput = {}
  ) => {
    const message = createSendMessage(workspaceId, workerId, text, input.fromAgentId)

    if (input.fromAgentId) {
      const sender = workspaceStore.getAgent(workspaceId, input.fromAgentId)
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      agentRuntime.writeSendPrompt(workspaceId, workerId, sender.name, worker.description, text)
    }

    insertMessage(message)
    workspaceStore.markTaskDispatched(workspaceId, workerId)
  }

  return {
    dispatchTask,
    dispatchTaskByWorkerName(
      workspaceId: string,
      workerName: string,
      text: string,
      input: DispatchTaskInput = {}
    ) {
      const worker = workspaceStore.getWorkerByName(workspaceId, workerName)
      dispatchTask(workspaceId, worker.id, text, input)
    },
    recordUserInput(workspaceId: string, orchestratorId: string, text: string) {
      workspaceStore.getAgent(workspaceId, orchestratorId)
      agentRuntime.writeUserInputPrompt(workspaceId, text)
      insertMessage(createUserInputMessage(workspaceId, orchestratorId, text))
    },
    reportTask(workspaceId: string, workerId: string, input: ReportTaskInput = {}) {
      const text = input.text ?? ''
      const status = input.status ?? 'success'
      const artifacts = input.artifacts ?? []
      if (input.requireActiveRun === true) {
        agentRuntime.writeReportPrompt(
          workspaceId,
          workspaceStore.getWorker(workspaceId, workerId).name,
          workerId,
          text,
          status,
          artifacts,
          { requireActiveRun: input.requireActiveRun }
        )
      }

      insertMessage(createReportMessage(workspaceId, workerId, text, status, artifacts))
      workspaceStore.markTaskReported(workspaceId, workerId)
    },
  }
}
