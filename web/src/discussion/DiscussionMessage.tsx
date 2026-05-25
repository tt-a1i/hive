import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { useI18n } from '../i18n.js'

import type { DiscussionMessage as DiscussionMessageType } from './types.js'

const PREVIEW_LINES = 3

const MODEL_BADGE_COLORS: Record<string, string> = {
  claude: 'bg-orange-100 text-orange-700',
  codex: 'bg-green-100 text-green-700',
  gemini: 'bg-blue-100 text-blue-700',
  opencode: 'bg-purple-100 text-purple-700',
}

type DiscussionMessageProps = {
  message: DiscussionMessageType
}

export const DiscussionMessage = ({ message }: DiscussionMessageProps) => {
  const { t } = useI18n()
  const lines = message.text.split('\n')
  const isLong = lines.length > PREVIEW_LINES
  const [expanded, setExpanded] = useState(false)

  const displayText = expanded || !isLong ? message.text : lines.slice(0, PREVIEW_LINES).join('\n')

  return (
    <div className="discussion-message group flex flex-col gap-1 rounded-md px-3 py-2 hover:bg-surface-secondary">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-pri">{message.fromAgentName}</span>
        {message.modelLabel ? (
          <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${MODEL_BADGE_COLORS[message.modelLabel] ?? 'bg-gray-100 text-gray-600'}`}>
            {message.modelLabel}
          </span>
        ) : null}
        <span className="text-xs text-ter">
          {t('discussion.roundLabel', { round: message.round })}
        </span>
      </div>
      <pre className="whitespace-pre-wrap text-sm leading-relaxed text-sec">{displayText}</pre>
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-link hover:underline"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? t('discussion.collapse') : t('discussion.expand')}
        </button>
      ) : null}
    </div>
  )
}
