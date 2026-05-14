import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { getHiveTeamRules } from './hive-team-guidance.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

export const buildAgentSessionBindingMarker = ({
  agent,
  workspace,
}: {
  agent: AgentSummary
  workspace: WorkspaceSummary
}) => `Hive session binding: workspace_id=${workspace.id}; agent_id=${agent.id}`

export const buildAgentLegacyIdentityMarker = ({
  agent,
  workspace,
}: {
  agent: AgentSummary
  workspace: WorkspaceSummary
}) => `你是 ${workspace.name} 的 ${agent.name}（${agent.role}）。`

export const buildAgentStartupInstructions = ({
  agent,
  workspace,
}: {
  agent: AgentSummary
  workspace: WorkspaceSummary
}) => {
  const lines = [
    '[Hive 系统消息：启动说明]',
    '',
    buildAgentLegacyIdentityMarker({ agent, workspace }),
    `当前 workspace: ${workspace.name}`,
    `项目路径: ${workspace.path}`,
    buildAgentSessionBindingMarker({ agent, workspace }),
    '',
    `你的角色：${agent.description}`,
    '',
  ]

  if (agent.role === 'orchestrator') {
    lines.push(
      '你的职责：',
      '- 直接响应 user，澄清需求并拆解任务',
      `- 维护 ${TASKS_RELATIVE_PATH}`,
      '- 按 worker 名称派单，并根据汇报推进下一步',
      '',
      '可用 team 命令：',
      '- team list',
      '- team send <worker-name> "<task>"',
      '',
      '派单时必须使用 worker name，不要使用 worker id。',
      '',
      'Hive worker 派单规则：',
      ...getHiveTeamRules(agent)
    )
  } else {
    lines.push(
      '可用 team 命令：',
      '- team report "<完整汇报>"',
      '',
      '完成任务后必须执行 `team report "<结论>"`。',
      '失败、阻塞或部分完成也用 `team report "<当前状态与原因>"` 汇报。',
      '不要调用 team send；worker 之间不能直接派单。',
      '',
      'Hive worker 边界：',
      ...getHiveTeamRules(agent)
    )
  }

  lines.push('')
  return lines.join('\n')
}
