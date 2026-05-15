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
      '- team report "<完整汇报>" [--dispatch <id>] [--artifact <path>]    完成/失败/阻塞汇报',
      '- team report --stdin [--dispatch <id>] [--artifact <path>]         同上，从 stdin 读正文（适合多行/含引号/特殊字符）',
      '- team status "<当前状态>" [--artifact <path>]                       中段进度/待命/接入状态',
      '- team status --stdin [--artifact <path>]                          同上，从 stdin 读正文',
      '- team list                                                        查看 workspace 内的 worker（含状态）',
      '- team --help                                                      仅查命令用法；**不是**汇报手段',
      '',
      '语法要点：',
      '- 正文是第一个 positional argument，flag 顺序任意：`team report "结论" --dispatch X` 和 `team report --dispatch X "结论"` 都成立。',
      "- 长正文（多行 / 含引号 / shell 特殊字符 / heredoc）一律走 `--stdin`，并用 *quoted* heredoc（`<<'EOF'`）防止 shell 展开 $vars / 反引号 / 命令替换：",
      "  例：`team report --stdin --dispatch <id> <<'EOF'`",
      '       `... 长报告（含 $VAR、`backtick`、"引号" 都按字面量保留）...`',
      '       `EOF`',
      '- CLI 报错会同时打印 USAGE，可直接对照修正参数。',
      '',
      '完成任务后必须执行 `team report "<结论>"`。',
      '失败、阻塞或部分完成也用 `team report "<当前状态与原因>"` 汇报。',
      '没有进行中的任务时，用 `team status "<当前状态>"` 汇报接入、待命或阻塞状态。',
      '不要调用 team send；worker 之间不能直接派单。',
      '',
      'Hive worker 边界：',
      ...getHiveTeamRules(agent)
    )
  }

  lines.push('')
  return lines.join('\n')
}
