import type { AgentRuntime } from './agent-runtime.js'
import type { MessageLogHandle, MessageLogRecord } from './message-log-store.js'
import {
  createReportMessage,
  createSendMessage,
  createUserInputMessage,
} from './runtime-message-builders.js'
import type { WorkspaceStore } from './workspace-store.js'

export interface TeamOperationsInput {
  agentRuntime: AgentRuntime
  deleteMessage: (handle: MessageLogHandle) => void
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
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
  deleteMessage,
  insertMessage,
  workspaceStore,
}: TeamOperationsInput) => {
  const dispatchTask = (
    workspaceId: string,
    workerId: string,
    text: string,
    input: DispatchTaskInput = {}
  ) => {
    const message = createSendMessage(workspaceId, workerId, text, input.fromAgentId)
    const messageHandle = insertMessage(message)

    try {
      if (input.fromAgentId) {
        const sender = workspaceStore.getAgent(workspaceId, input.fromAgentId)
        const worker = workspaceStore.getWorker(workspaceId, workerId)
        agentRuntime.writeSendPrompt(workspaceId, workerId, sender.name, worker.description, text)
      }

      workspaceStore.markTaskDispatched(workspaceId, workerId)
    } catch (error) {
      deleteMessage(messageHandle)
      throw error
    }
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
      const messageHandle = insertMessage(
        createReportMessage(workspaceId, workerId, text, status, artifacts)
      )
      try {
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

        workspaceStore.markTaskReported(workspaceId, workerId)
      } catch (error) {
        deleteMessage(messageHandle)
        throw error
      }
    },
  }
}
