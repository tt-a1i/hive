import type { DispatchMessageRecord } from '../shared/team-collaboration.js'
import {
  authorizeDispatchMessage,
  type DispatchMessagePolicyPorts,
} from './dispatch-message-policy.js'
import { getDispatchQuestionReplyInput } from './dispatch-message-reply.js'
import { ConflictError, ForbiddenError } from './http-errors.js'

/** Questions stay ordinary messages; their answerability is owned by the existing policy. */
export const createDispatchQuestionOperations = (ports: DispatchMessagePolicyPorts) => {
  const readQuestion = (workspaceId: string, agentId: string, questionId: string) => {
    const question = ports.messages.getMessage(workspaceId, questionId)
    if (!question || question.kind !== 'question')
      throw new ConflictError('Question does not exist in this workspace')
    if (question.fromAgentId !== agentId && question.recipientAgentId !== agentId)
      throw new ForbiddenError('Only the question sender or recipient may inspect it')
    return question
  }
  const replyInput = (question: DispatchMessageRecord, text: string) => {
    const input = getDispatchQuestionReplyInput(question, text)
    if (!input) throw new ConflictError('Question has no reply responsibility')
    return input
  }
  return {
    listSentDispatchQuestions: ports.messages.listSentQuestions,
    getDispatchQuestion(workspaceId: string, agentId: string, questionId: string) {
      const question = readQuestion(workspaceId, agentId, questionId)
      const answers = ports.messages.listAnswers(workspaceId, questionId)
      let status: 'answered' | 'pending' | 'closed' = answers.length ? 'answered' : 'pending'
      if (!answers.length) {
        if (!ports.hasAgent(workspaceId, question.recipientAgentId)) status = 'closed'
        else {
          try {
            authorizeDispatchMessage(
              ports,
              workspaceId,
              question.recipientAgentId,
              replyInput(question, 'check reply eligibility')
            )
          } catch (error) {
            if (!(error instanceof ConflictError || error instanceof ForbiddenError)) throw error
            status = 'closed'
          }
        }
      }
      return { question, answers, status }
    },
    getDispatchReplyInput(workspaceId: string, agentId: string, questionId: string, text: string) {
      const question = readQuestion(workspaceId, agentId, questionId)
      if (question.recipientAgentId !== agentId)
        throw new ForbiddenError('Only the question recipient may answer it')
      return replyInput(question, text)
    },
  }
}
