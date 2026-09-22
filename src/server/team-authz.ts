import type { AgentSummary } from '../shared/types.js'
import { ForbiddenError, UnauthorizedError } from './http-errors.js'

export type TeamCommand =
  | 'delegate'
  | 'message'
  | 'messages'
  | 'send'
  | 'list'
  | 'next'
  | 'report'
  | 'recall'
  | 'memory_add'
  | 'memory_apply'
  | 'memory_dream_show'
  | 'memory_forget'
  | 'memory_search'
  | 'memory_show'
  | 'status'
  | 'cancel'
  | 'help'
  | 'spawn'
  | 'review'
  | 'dismiss'
  | 'workflow'
  | 'goal_report'

const ORCHESTRATOR_COMMANDS = new Set<TeamCommand>([
  'message',
  'messages',
  'send',
  'list',
  'next',
  'cancel',
  'help',
  'recall',
  'memory_add',
  'memory_apply',
  'memory_dream_show',
  'memory_forget',
  'memory_search',
  'memory_show',
  'spawn',
  'review',
  'dismiss',
  'workflow',
  'goal_report',
])
const WORKER_COMMANDS = new Set<TeamCommand>([
  'delegate',
  'cancel',
  'message',
  'messages',
  'report',
  'status',
  'help',
  'recall',
  'memory_dream_show',
  'memory_search',
  'memory_show',
])
const WORKER_ROLES = new Set<AgentSummary['role']>(['coder', 'reviewer', 'tester', 'custom'])

export const commandAllowedForRole = (role: AgentSummary['role'], command: TeamCommand) => {
  if (role === 'orchestrator') return ORCHESTRATOR_COMMANDS.has(command)
  if (WORKER_ROLES.has(role)) return WORKER_COMMANDS.has(command)
  return false
}

interface AuthenticateInput {
  fromAgentId: string | undefined
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  token: string | undefined
  validateToken: (agentId: string, token: string | undefined) => boolean
  workspaceId: string
}

export const authenticateCliAgent = ({
  fromAgentId,
  getAgent,
  token,
  validateToken,
  workspaceId,
}: AuthenticateInput): AgentSummary => {
  if (!fromAgentId) {
    throw new UnauthorizedError('Missing agent identity')
  }
  if (!validateToken(fromAgentId, token)) {
    throw new UnauthorizedError('Invalid or missing agent token')
  }
  let agent: AgentSummary
  try {
    agent = getAgent(workspaceId, fromAgentId)
  } catch {
    throw new UnauthorizedError('Agent not found in workspace')
  }
  return agent
}

export const requireCommandForRole = (agent: AgentSummary, command: TeamCommand) => {
  if (!commandAllowedForRole(agent.role, command)) {
    throw new ForbiddenError(`Role '${agent.role}' is not allowed to run team ${command}`)
  }
}
