import { useI18n } from '../i18n.js'

import { DiscussionMessage } from './DiscussionMessage.js'
import { DiscussionTypingIndicator } from './DiscussionTypingIndicator.js'
import type { DiscussionMessage as DiscussionMessageType, DiscussionMember } from './types.js'

type DiscussionRoundGroupProps = {
  round: number
  maxRounds: number
  messages: DiscussionMessageType[]
  members: DiscussionMember[]
  isCurrentRound: boolean
  submittedAgentIds: Set<string>
}

export const DiscussionRoundGroup = ({
  round,
  maxRounds,
  messages,
  members,
  isCurrentRound,
  submittedAgentIds,
}: DiscussionRoundGroupProps) => {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-1">
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface-primary px-3 py-1.5">
        <span className="text-xs font-medium text-ter">
          {t('discussion.roundProgress', { current: round, total: maxRounds })}
        </span>
        {isCurrentRound ? (
          <span className="pill pill--blue text-[10px]">{t('discussion.current')}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5">
        {messages.map((msg) => (
          <DiscussionMessage key={msg.sequence} message={msg} />
        ))}
      </div>
      {isCurrentRound ? (
        <DiscussionTypingIndicator
          members={members}
          currentRound={round}
          submittedAgentIds={submittedAgentIds}
        />
      ) : null}
    </div>
  )
}
