import type { AgentSummary } from '../shared/types.js'

const ORCHESTRATOR_RULES = [
  'Hive worker 是右侧卡片里的真实 CLI agent，不是你所在 CLI 的内置 subagent / 子代理工具。',
  '当 user 要你“让 worker ... / 给 worker 找活 / 让成员处理”时，先执行 `team list` 确认真实 Hive worker。',
  '如果只有一个可用 worker，直接用 `team send <worker-name> "<task>"` 派给它；不要把选择题丢回给 user。',
  '当 user 要你“让 worker ...”时，必须用 `team send <worker-name> "<task>"` 派给 Hive worker。',
  '不要使用你所在 CLI 的内置 subagent / 子代理工具（如 Task / Explore 等）来代替 Hive worker；它们不会出现在 Hive UI，也不会更新 Hive 调度状态。',
]

const WORKER_RULES = [
  '你是 Hive 右侧卡片里的真实 CLI worker，不是你所在 CLI 的内置 subagent。',
  '不要调用 team send，也不要再启动你所在 CLI 的内置 subagent / 子代理工具（如 Task / Explore 等）来替你完成派单。',
  '完成或阻塞已派发任务时必须用 `team report` 汇报给 Orchestrator。',
  '如果当前没有明确派发任务，只是汇报待命、环境或状态，使用 `team status "<当前状态>"`。',
]

export const getHiveTeamRules = (agent: Pick<AgentSummary, 'role'>) =>
  agent.role === 'orchestrator' ? ORCHESTRATOR_RULES : WORKER_RULES
