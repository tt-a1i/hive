import { useI18n } from '../i18n.js'

import type { DiscussionMember } from './types.js'

type DiscussionTypingIndicatorProps = {
  members: DiscussionMember[]
  currentRound: number
  submittedAgentIds: Set<string>
}

export const DiscussionTypingIndicator = ({
  members,
  currentRound,
  submittedAgentIds,
}: DiscussionTypingIndicatorProps) => {
  const { t } = useI18n()
  const pending = members.filter((m) => !submittedAgentIds.has(m.agentId))

  if (pending.length === 0) return null

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-ter">
      <span className="typing-dots" aria-hidden>
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </span>
      <span>
        {pending.length === 1
          ? t('discussion.thinkingSingle', { name: pending[0]!.agentName })
          : t('discussion.thinkingMultiple', { count: pending.length })}
      </span>
    </div>
  )
}
