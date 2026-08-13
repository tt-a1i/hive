export interface FullRecoveryBriefInput {
  topic: string
  phase: string
  currentRound: number
  maxRounds: number
  ownSubmissions: string[]
  visibleMessages: { name: string; text: string }[]
  nextAction: string
}

export interface MinimalDeltaBriefInput {
  topic: string
  phase: string
  currentRound: number
  nextAction: string
}

export interface TerminalNoticeInput {
  topic: string
  finalStatus: 'concluded' | 'cancelled'
  synthesisSnippet?: string
}

export const buildFullRecoveryBrief = (input: FullRecoveryBriefInput): string => {
  const lines = [
    `[Hive 系统消息：讨论恢复上下文]`,
    '',
    `你在 crash 前参与了讨论「${input.topic}」。`,
    `当前阶段：${input.phase}，轮次：${input.currentRound}/${input.maxRounds}`,
    '',
  ]

  if (input.ownSubmissions.length > 0) {
    lines.push('## 你之前的提交')
    for (const sub of input.ownSubmissions) {
      lines.push(`- ${sub}`)
    }
    lines.push('')
  }

  if (input.visibleMessages.length > 0) {
    lines.push('## 最近讨论消息')
    for (const msg of input.visibleMessages) {
      lines.push(`**${msg.name}**: ${msg.text}`)
    }
    lines.push('')
  }

  lines.push(`## 你现在需要做`)
  lines.push(input.nextAction)

  return lines.join('\n')
}

export const buildMinimalDeltaBrief = (input: MinimalDeltaBriefInput): string =>
  [
    `[Hive 系统消息：讨论状态变更]`,
    '',
    `讨论「${input.topic}」已进入 ${input.phase} 阶段（轮次 ${input.currentRound}）。`,
    '',
    `## 你现在需要做`,
    input.nextAction,
  ].join('\n')

export const buildTerminalNotice = (input: TerminalNoticeInput): string => {
  const lines = [
    `[Hive 系统消息：讨论已${input.finalStatus === 'concluded' ? '结束' : '取消'}]`,
    '',
    `讨论「${input.topic}」已${input.finalStatus === 'concluded' ? '达成结论' : '被取消'}。`,
  ]

  if (input.synthesisSnippet) {
    lines.push('')
    lines.push('## 结论摘要')
    lines.push(input.synthesisSnippet)
  }

  lines.push('')
  lines.push('你可以继续执行其他任务。')

  return lines.join('\n')
}
