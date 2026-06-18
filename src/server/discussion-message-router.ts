import type {
  DiscussionGroup,
  DiscussionMember,
  DiscussionMessage,
} from './discussion-operations.js'

// --- Per-agent write queue (ensures ordered stdin injection) ---

const writeQueues = new Map<string, Promise<void>>()

type WriteFn = (workspaceId: string, agentId: string, text: string) => void

const enqueueWrite = (
  workspaceId: string,
  agentId: string,
  text: string,
  writeFn: WriteFn
): Promise<void> => {
  const key = `${workspaceId}:${agentId}`
  const prev = writeQueues.get(key) ?? Promise.resolve()
  const next = prev.then(() => {
    writeFn(workspaceId, agentId, text)
  }).finally(() => {
    if (writeQueues.get(key) === next) writeQueues.delete(key)
  })
  writeQueues.set(key, next)
  return next
}

export const clearWriteQueue = (workspaceId: string, agentId: string) => {
  writeQueues.delete(`${workspaceId}:${agentId}`)
}

// --- Broadcast ---

export interface BroadcastResult {
  delivered: string[]
  failed: string[]
}

export const broadcastToMembers = async (
  workspaceId: string,
  members: DiscussionMember[],
  excludeAgentId: string,
  text: string,
  writeFn: WriteFn
): Promise<BroadcastResult> => {
  const delivered: string[] = []
  const failed: string[] = []

  for (const m of members) {
    if (
      m.agent_id !== excludeAgentId &&
      m.member_status !== 'skipped' &&
      m.member_status !== 'failed'
    ) {
      try {
        await enqueueWrite(workspaceId, m.agent_id, text, writeFn)
        delivered.push(m.agent_id)
      } catch (error) {
        console.error(`[hive:discussion] stdin write failed for ${m.agent_id}:`, error)
        failed.push(m.agent_id)
      }
    }
  }

  return { delivered, failed }
}

export const injectToAgent = (
  workspaceId: string,
  agentId: string,
  text: string,
  writeFn: WriteFn
) => {
  enqueueWrite(workspaceId, agentId, text, writeFn).catch((err) => {
    console.error(`[hive:discussion] inject failed for ${agentId}:`, err)
  })
}

// --- Prompt Formatters ---

export const formatDiscussionInvite = (
  topic: string,
  memberNames: string[],
  maxRounds: number
): string =>
  [
    '[Hive 讨论：你被邀请参与讨论]',
    `话题：${topic}`,
    `成员：${memberNames.join(', ')}`,
    '规则：',
    '1. 请独立思考这个问题，形成你的初始观点',
    '2. 完成后用 `team discuss "<your-initial-position>"` 发表',
    '3. 你的观点会被缓冲，直到所有成员都提交后才会互相可见',
    `4. 之后进入讨论阶段（共 ${maxRounds} 轮），你可以回应其他成员的观点`,
    '5. 讨论目标：通过碰撞产生新的洞察，而非简单同意某人',
  ].join('\n')

export const formatInitialBundle = (
  positions: Array<{ name: string; text: string }>,
  round: number,
  maxRounds: number
): string => {
  const lines = [`[Hive 讨论：所有成员初始观点（共 ${positions.length} 人）]`, '']
  for (const p of positions) {
    lines.push(`@${p.name} 的观点：`)
    lines.push(p.text)
    lines.push('')
  }
  lines.push('---')
  lines.push(
    `讨论阶段开始（第 ${round} 轮/共 ${maxRounds} 轮）。`
  )
  lines.push('')
  lines.push('请按以下结构回应（每条都要回答）：')
  lines.push('1. 【最强论点】其他人最强的论点是什么？为什么强？')
  lines.push('2. 【最弱假设】最危险/最弱的假设是什么？（包括你自己的）')
  lines.push('3. 【反例】一个具体的反例或失败场景')
  lines.push('4. 【综合方案】一个新的综合方案（不能完全等于任何人的初始观点）')
  lines.push('5. 【信心变化】你的信心变化（提高/降低/不变，为什么）')
  lines.push('')
  lines.push('用 `team discuss "<your-reply>"` 发言。')
  return lines.join('\n')
}

export const formatDiscussMessage = (
  senderName: string,
  round: number,
  maxRounds: number,
  text: string
): string =>
  [
    `[Hive 讨论：来自 @${senderName} (第 ${round} 轮/共 ${maxRounds} 轮)]`,
    text,
    '',
    '---',
    '请按结构回应：1.最强论点 2.最弱假设 3.反例 4.综合方案 5.信心变化',
    '用 `team discuss "<your-reply>"` 发言。',
  ].join('\n')

export const formatConcludeInvite = (): string =>
  [
    '[Hive 讨论：讨论轮次结束，请提交最终结论]',
    '请综合本次讨论的所有观点和碰撞，用 `team discuss --final "<your-final-answer>"` 提交你的最终结论。',
    '你的结论应该是经过讨论后的综合判断，可以不同于你的初始观点。',
  ].join('\n')

export const formatCancelNotice = (reason?: string): string =>
  [
    '[Hive 讨论：讨论已被终止]',
    reason ? `原因：${reason}` : '讨论已被 Orchestrator 终止。',
    '你可以继续执行其他任务。',
  ].join('\n')

export const formatSynthesisReport = (
  group: DiscussionGroup,
  members: DiscussionMember[],
  messages: DiscussionMessage[]
): string => {
  const activeMembers = members.filter(
    (m) => m.member_status !== 'skipped' && m.member_status !== 'failed'
  )
  const memberNames = activeMembers.map((m) => m.agent_name).join(', ')

  const changedMembers = activeMembers.filter(
    (m) => m.initial_position && m.final_position && m.initial_position !== m.final_position
  )
  const unchangedMembers = activeMembers.filter(
    (m) => m.initial_position && m.final_position && m.initial_position === m.final_position
  )

  const lines = [
    `[Hive 讨论结果：讨论组 ${group.id} 已结束]`,
    `话题：${group.topic}`,
    `参与者：${memberNames}`,
    `轮次：${group.current_round}/${group.max_rounds} | 消息数：${messages.length}`,
    '',
    '## 1. Discussion Delta — 讨论涌现的新洞察',
    '（以下内容在讨论开始前不存在于任何单一成员的观点中）',
  ]

  for (const m of changedMembers) {
    lines.push(`- @${m.agent_name} 的综合判断：${m.final_position}`)
  }
  if (changedMembers.length === 0) {
    lines.push('- 各成员立场未发生显著变化')
  }

  lines.push('')
  lines.push('## 2. Changed Positions — 立场变化')

  for (const m of changedMembers) {
    lines.push(`- @${m.agent_name}:`)
    lines.push(`  初始：${m.initial_position}`)
    lines.push(`  最终：${m.final_position}`)
  }
  if (changedMembers.length === 0) {
    lines.push('- 无成员改变立场')
  }

  lines.push('')
  lines.push('## 3. Unresolved Disagreements — 未解分歧')

  if (unchangedMembers.length > 1) {
    for (const m of unchangedMembers) {
      lines.push(`- @${m.agent_name} 坚持：${m.final_position}`)
    }
  } else {
    lines.push('- 无显著未解分歧')
  }

  lines.push('')
  lines.push('## 4. Decision-ready Recommendation — 综合建议')
  lines.push('请基于以上 Delta 和分歧，形成你的最终决策。关注：')
  lines.push('- 讨论中新涌现的洞察（Delta 部分）优先于初始观点')
  lines.push('- 未解分歧的双方各有什么核心担忧')
  lines.push('- 是否存在综合方案能同时回应双方担忧')

  lines.push('')
  lines.push('## 5. Suggested Next Actions — 后续行动')
  lines.push('- 基于讨论结果，分配具体实施任务')
  lines.push('- 对未解分歧设立验证实验或 POC')

  return lines.join('\n')
}
