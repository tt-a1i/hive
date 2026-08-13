import { MessageCircle, Users } from 'lucide-react'
import { useMemo } from 'react'

import { useI18n } from '../i18n.js'

import type { DiscussionGroup, DiscussionMessage, DiscussionStatus } from './types.js'

const statusTone: Record<DiscussionStatus, string> = {
  thinking: 'pill--yellow',
  discussing: 'pill--blue',
  concluding: 'pill--purple',
  concluded: 'pill--green',
  cancelled: 'pill--red',
}

const statusDotColor: Record<DiscussionStatus, string> = {
  thinking: 'bg-yellow-400',
  discussing: 'bg-blue-400',
  concluding: 'bg-purple-400',
  concluded: 'bg-green-400',
  cancelled: 'bg-red-400',
}

const MODEL_BADGE_COLORS: Record<string, string> = {
  claude: 'bg-orange-100 text-orange-700',
  codex: 'bg-green-100 text-green-700',
  gemini: 'bg-blue-100 text-blue-700',
  opencode: 'bg-purple-100 text-purple-700',
}

type DiscussionHeaderProps = {
  group: DiscussionGroup
  messages: DiscussionMessage[]
  onClose: () => void
}

export const DiscussionHeader = ({ group, messages, onClose }: DiscussionHeaderProps) => {
  const { t } = useI18n()
  const statusLabel = `discussion.status.${group.status}` as const

  const phaseDetail = useMemo(() => {
    const total = group.members.length
    if (group.status === 'thinking') {
      const submitted = group.members.filter((m) => m.initialPosition !== null).length
      return t('discussion.phase.thinking', { submitted, total })
    }
    if (group.status === 'discussing') {
      const currentRoundMsgs = messages.filter((m) => m.round === group.currentRound)
      const spoken = new Set(currentRoundMsgs.map((m) => m.fromAgentId)).size
      return t('discussion.phase.discussing', {
        round: group.currentRound,
        maxRounds: group.maxRounds,
        spoken,
        total,
      })
    }
    if (group.status === 'concluding') {
      const submitted = group.members.filter((m) => m.finalPosition !== null).length
      return t('discussion.phase.concluding', { submitted, total })
    }
    return ''
  }, [group, messages, t])

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageCircle size={16} className="text-ter" />
          <h3 className="text-sm font-semibold text-pri">{t('discussion.title')}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-ter hover:text-pri"
          aria-label={t('discussion.close')}
        >
          &times;
        </button>
      </div>
      <p className="line-clamp-2 text-sm text-sec">{group.topic}</p>
      <div className="flex items-center gap-3">
        <span className={`pill ${statusTone[group.status]}`}>{t(statusLabel)}</span>
        <span className="flex items-center gap-1 text-xs text-ter">
          <Users size={12} />
          {group.members.length}
        </span>
        <span className="text-xs text-ter">
          {t('discussion.roundProgress', {
            current: group.currentRound,
            total: group.maxRounds,
          })}
        </span>
      </div>
      {phaseDetail ? (
        <div className="flex items-center gap-1.5 text-xs text-sec">
          <span className={`inline-block h-2 w-2 rounded-full ${statusDotColor[group.status]}`} />
          {phaseDetail}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {group.members.map((m) => (
          <span key={m.agentId} className="flex items-center gap-1 text-xs text-sec">
            <span>{m.agentName}</span>
            {m.modelLabel ? (
              <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${MODEL_BADGE_COLORS[m.modelLabel] ?? 'bg-gray-100 text-gray-600'}`}>
                {m.modelLabel}
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  )
}
