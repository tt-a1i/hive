import type { AgentSummary } from '../shared/types.js'

const ORCHESTRATOR_RULES = [
  'Hive worker 是右侧卡片里的真实 CLI agent，不是你所在 CLI 的内置 subagent / 子代理工具。',
  '当 user 要你“让 worker ... / 给 worker 找活 / 让成员处理”时，先执行 `team list` 确认真实 Hive worker。',
  '如果只有一个可用 worker，直接用 `team send <worker-name> "<task>"` 派给它；不要把选择题丢回给 user。',
  '当 user 要你“让 worker ...”时，必须用 `team send <worker-name> "<task>"` 派给 Hive worker。',
  '不要使用你所在 CLI 的内置 subagent / 子代理工具（如 Task / Explore 等）来代替 Hive worker；它们不会出现在 Hive UI，也不会更新 Hive 调度状态。',
  '`team list` 返回的 `last_pty_line` 是该 worker PTY 终端的最后一行原始输出（含任意 stdout / help / 控制序列噪声），**不是** worker 的正式汇报。正式汇报只来自 stdin 注入的 `[Hive 系统消息：来自 @<name> 的汇报]` 或 `[Hive 系统消息：来自 @<name> 的状态更新]`——只把这两种来源当作 reply。',
]

const WORKER_RULES = [
  '你是 Hive 右侧卡片里的真实 CLI worker，不是你所在 CLI 的内置 subagent。',
  '不要调用 team send，也不要再启动你所在 CLI 的内置 subagent / 子代理工具（如 Task / Explore 等）来替你完成派单。',
  '完成或阻塞已派发任务时必须用 `team report` 汇报给 Orchestrator。',
  '如果当前没有明确派发任务，只是汇报待命、环境或状态，使用 `team status "<当前状态>"`。',
  '`team --help` 只用于查命令语法，**绝不是** 汇报手段；其输出不会进入 Orchestrator 视野，跑完后仍需正式调用 `team report` / `team status`。',
  '`team report` / `team status` 报错时会同时打印 USAGE，按 USAGE 修正参数后重试；不要把 `team --help` 当成"自我探查"的替身。',
]

export const getHiveTeamRules = (agent: Pick<AgentSummary, 'role'>) =>
  agent.role === 'orchestrator' ? ORCHESTRATOR_RULES : WORKER_RULES
