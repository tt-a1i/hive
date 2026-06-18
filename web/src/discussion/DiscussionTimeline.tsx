import { Clock, MessageCircle, MessageSquare, Settings, Trophy, Zap } from 'lucide-react'
import { useState } from 'react'

import { useI18n } from '../i18n.js'

import type { TimelineEvent } from './api.js'

type DiscussionTimelineProps = {
  events: TimelineEvent[]
}

const EVENT_CONFIG: Record<TimelineEvent['type'], { color: string; icon: typeof Clock }> = {
  created: { color: 'text-gray-400 border-gray-400/40 bg-gray-400/10', icon: Settings },
  initial: { color: 'text-yellow-500 border-yellow-500/40 bg-yellow-500/10', icon: Zap },
  discuss: { color: 'text-blue-500 border-blue-500/40 bg-blue-500/10', icon: MessageCircle },
  system: { color: 'text-gray-400 border-gray-400/40 bg-gray-400/10', icon: Settings },
  conclude: { color: 'text-purple-500 border-purple-500/40 bg-purple-500/10', icon: MessageSquare },
  concluded: { color: 'text-green-500 border-green-500/40 bg-green-500/10', icon: Trophy },
}

const formatTime = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export const DiscussionTimeline = ({ events }: DiscussionTimelineProps) => {
  const { t } = useI18n()
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  if (events.length === 0) {
    return <p className="p-4 text-xs text-ter">{t('discussion.timeline.empty')}</p>
  }

  return (
    <div className="flex flex-col py-2 pl-4 pr-2">
      {events.map((event, idx) => {
        const config = EVENT_CONFIG[event.type]
        const Icon = config.icon
        const isExpanded = expandedIdx === idx
        const summary = event.type === 'created'
          ? t('discussion.timeline.created')
          : event.text.length > 80
            ? `${event.text.slice(0, 80)}…`
            : event.text

        return (
          <div key={idx} className="relative flex gap-3 pb-3">
            {idx < events.length - 1 ? (
              <div className="absolute left-[11px] top-[24px] bottom-0 w-px bg-border" />
            ) : null}
            <div className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${config.color}`}>
              <Icon size={12} />
            </div>
            <button
              type="button"
              className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
              onClick={() => setExpandedIdx(isExpanded ? null : idx)}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-ter">{formatTime(event.timestamp)}</span>
                {event.agent_name ? (
                  <span className="text-xs font-medium text-pri">{event.agent_name}</span>
                ) : null}
                <span className="text-[10px] text-ter">
                  {t(`discussion.timeline.type.${event.type}` as 'discussion.timeline.type.created')}
                </span>
                {event.round > 0 ? (
                  <span className="text-[10px] text-ter">R{event.round}</span>
                ) : null}
              </div>
              {isExpanded ? (
                <pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded bg-surface-secondary p-2 text-xs leading-relaxed text-sec">
                  {event.type === 'created' ? JSON.stringify(JSON.parse(event.text), null, 2) : event.text}
                </pre>
              ) : (
                <p className="truncate text-xs text-ter">{summary}</p>
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}
