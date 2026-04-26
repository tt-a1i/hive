import type { AgentSummary } from '../shared/types.js'

const ORCHESTRATOR_RULES = [
  'Hive worker 是右侧卡片里的真实 CLI agent，不是 Claude Code 内置的 Task / Explore / subagent。',
  '当 user 要你“让 worker ...”时，必须用 `team send <worker-name> "<task>"` 派给 Hive worker。',
  '不要使用 Claude Code 内置的 Task / Explore / subagent 来代替 Hive worker；它们不会出现在 Hive UI，也不会触发 pending_task_count / team report。',
]

const WORKER_RULES = [
  '你是 Hive 右侧卡片里的真实 CLI worker，不是 Claude Code 内置 subagent。',
  '不要调用 team send，也不要再启动 Claude Code 内置的 Task / Explore / subagent 来替你完成派单。',
  '完成或阻塞时必须用 `team report` 汇报给 Orchestrator。',
]

export const getHiveTeamRules = (agent: Pick<AgentSummary, 'role'>) =>
  agent.role === 'orchestrator' ? ORCHESTRATOR_RULES : WORKER_RULES
