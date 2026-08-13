import { Compass, FastForward, SkipForward, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '../i18n.js'

import { DiscussionHeader } from './DiscussionHeader.js'
import { DiscussionRoundGroup } from './DiscussionRoundGroup.js'
import { DiscussionTimeline } from './DiscussionTimeline.js'
import type { TimelineEvent } from './api.js'
import type { DiscussionGroup, DiscussionMessage } from './types.js'

type DiscussionPanelProps = {
  group: DiscussionGroup | null
  messages: DiscussionMessage[]
  timelineEvents?: TimelineEvent[]
  onClose: () => void
  onEndDiscussion?: (cancel: boolean) => void
  onSteer?: (text: string) => Promise<void>
  onExtend?: (rounds: number) => Promise<void>
  onSkipMember?: (agentName: string) => Promise<void>
}

export const DiscussionPanel = ({
  group,
  messages,
  timelineEvents,
  onClose,
  onEndDiscussion,
  onSteer,
  onExtend,
  onSkipMember,
}: DiscussionPanelProps) => {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)

  const messagesByRound = useMemo(() => {
    const grouped = new Map<number, DiscussionMessage[]>()
    for (const msg of messages) {
      const existing = grouped.get(msg.round)
      if (existing) {
        existing.push(msg)
      } else {
        grouped.set(msg.round, [msg])
      }
    }
    return grouped
  }, [messages])

  const submittedAgentIds = useMemo(() => {
    if (!group) return new Set<string>()
    const currentRoundMsgs = messagesByRound.get(group.currentRound) ?? []
    return new Set(currentRoundMsgs.map((m) => m.fromAgentId))
  }, [group, messagesByRound])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length])

  if (!group) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-ter">{t('discussion.noActive')}</p>
      </div>
    )
  }

  const isDiscussing = group.status === 'discussing'
  const isActive = group.status === 'thinking' || group.status === 'discussing'
  const rounds = Array.from(messagesByRound.keys()).sort((a, b) => a - b)

  return (
    <div className="flex h-full flex-col">
      <DiscussionHeader group={group} messages={messages} onClose={onClose} />
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-2">
          {rounds.map((round) => (
            <DiscussionRoundGroup
              key={round}
              round={round}
              maxRounds={group.maxRounds}
              messages={messagesByRound.get(round) ?? []}
              members={group.members}
              isCurrentRound={round === group.currentRound}
              submittedAgentIds={submittedAgentIds}
            />
          ))}
        </div>
      </div>
      {isDiscussing ? (
        <InterventionToolbar
          group={group}
          submittedAgentIds={submittedAgentIds}
          onSteer={onSteer}
          onExtend={onExtend}
          onSkipMember={onSkipMember}
          onEnd={onEndDiscussion}
        />
      ) : isActive && onEndDiscussion ? (
        <div className="border-t border-border px-4 py-2">
          <button
            type="button"
            onClick={() => onEndDiscussion(false)}
            className="btn btn--danger btn--sm w-full"
          >
            {t('discussion.endDiscussion')}
          </button>
        </div>
      ) : null}
      {group.status === 'concluded' ? (
        <ConcludedTabs messages={messages} group={group} timelineEvents={timelineEvents ?? []} />
      ) : null}
    </div>
  )
}

// --- Intervention Toolbar ---

type InterventionToolbarProps = {
  group: DiscussionGroup
  submittedAgentIds: Set<string>
  onSteer?: ((text: string) => Promise<void>) | undefined
  onExtend?: ((rounds: number) => Promise<void>) | undefined
  onSkipMember?: ((agentName: string) => Promise<void>) | undefined
  onEnd?: ((cancel: boolean) => void) | undefined
}

const InterventionToolbar = ({
  group,
  submittedAgentIds,
  onSteer,
  onExtend,
  onSkipMember,
  onEnd,
}: InterventionToolbarProps) => {
  const { t } = useI18n()
  const [steerOpen, setSteerOpen] = useState(false)
  const [steerText, setSteerText] = useState('')
  const [extendOpen, setExtendOpen] = useState(false)
  const [skipOpen, setSkipOpen] = useState(false)
  const [endOpen, setEndOpen] = useState(false)

  const pendingMembers = group.members.filter((m) => !submittedAgentIds.has(m.agentId))

  const handleSteer = useCallback(async () => {
    if (!steerText.trim() || !onSteer) return
    await onSteer(steerText.trim())
    setSteerText('')
    setSteerOpen(false)
  }, [steerText, onSteer])

  return (
    <div className="border-t border-border px-3 py-2">
      {steerOpen ? (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            className="input text-sm"
            placeholder={t('discussion.toolbar.steerPlaceholder')}
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSteer()}
            autoFocus
          />
          <div className="flex gap-2">
            <button type="button" className="btn btn--primary btn--sm" onClick={handleSteer}>
              {t('discussion.toolbar.steerConfirm')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSteerOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : extendOpen ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-sec">{t('discussion.toolbar.extendLabel')}</span>
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => { onExtend?.(n); setExtendOpen(false) }}
            >
              +{n}
            </button>
          ))}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExtendOpen(false)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : skipOpen ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-sec">{t('discussion.toolbar.skipLabel')}</span>
          {pendingMembers.map((m) => (
            <button
              key={m.agentId}
              type="button"
              className="btn btn--ghost btn--sm text-left"
              onClick={() => { onSkipMember?.(m.agentName); setSkipOpen(false) }}
            >
              {m.agentName}
            </button>
          ))}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSkipOpen(false)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : endOpen ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-sec">{t('discussion.toolbar.endConfirm')}</span>
          <div className="flex gap-2">
            <button type="button" className="btn btn--primary btn--sm" onClick={() => { onEnd?.(false); setEndOpen(false) }}>
              {t('discussion.toolbar.endSummarize')}
            </button>
            <button type="button" className="btn btn--danger btn--sm" onClick={() => { onEnd?.(true); setEndOpen(false) }}>
              {t('discussion.toolbar.endCancel')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEndOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSteerOpen(true)} title={t('discussion.toolbar.steer')}>
            <Compass size={14} />
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExtendOpen(true)} title={t('discussion.toolbar.extend')}>
            <FastForward size={14} />
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setSkipOpen(true)}
            title={t('discussion.toolbar.skip')}
            disabled={pendingMembers.length === 0}
          >
            <SkipForward size={14} />
          </button>
          <div className="ml-auto">
            <button type="button" className="btn btn--danger btn--sm" onClick={() => setEndOpen(true)} title={t('discussion.toolbar.end')}>
              <Square size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Concluded Tabs (Report / Timeline) ---

type ConcludedTabsProps = {
  messages: DiscussionMessage[]
  group: DiscussionGroup
  timelineEvents: TimelineEvent[]
}

const ConcludedTabs = ({ messages, group, timelineEvents }: ConcludedTabsProps) => {
  const { t } = useI18n()
  const [tab, setTab] = useState<'report' | 'timeline'>('report')

  return (
    <div className="border-t border-border">
      <div className="flex border-b border-border/50">
        <button
          type="button"
          className={`flex-1 px-3 py-1.5 text-xs font-medium ${tab === 'report' ? 'border-b-2 border-blue-500 text-pri' : 'text-ter hover:text-sec'}`}
          onClick={() => setTab('report')}
        >
          {t('discussion.concluded.tabReport')}
        </button>
        <button
          type="button"
          className={`flex-1 px-3 py-1.5 text-xs font-medium ${tab === 'timeline' ? 'border-b-2 border-blue-500 text-pri' : 'text-ter hover:text-sec'}`}
          onClick={() => setTab('timeline')}
        >
          {t('discussion.concluded.tabTimeline')}
        </button>
      </div>
      {tab === 'report' ? (
        <DeltaReport messages={messages} group={group} />
      ) : (
        <DiscussionTimeline events={timelineEvents} />
      )}
    </div>
  )
}

// --- Delta-first Report ---

type DeltaReportProps = {
  messages: DiscussionMessage[]
  group: DiscussionGroup
}

const DELTA_SECTIONS = [
  'Discussion Delta',
  'Changed Positions',
  'Unresolved Disagreements',
  'Decision-ready Recommendation',
  'Suggested Next Actions',
]

const DeltaReport = ({ group }: DeltaReportProps) => {
  const { t } = useI18n()
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([0]))

  const sections = useMemo(() => {
    const result: Array<{ title: string; content: string }> = []
    const changedMembers = group.members.filter(
      (m) => m.initialPosition && m.finalPosition && m.initialPosition !== m.finalPosition
    )
    const unchangedMembers = group.members.filter(
      (m) => m.initialPosition && m.finalPosition && m.initialPosition === m.finalPosition
    )

    result.push({
      title: DELTA_SECTIONS[0]!,
      content: changedMembers.length > 0
        ? changedMembers.map((m) => `${m.agentName}: ${m.finalPosition}`).join('\n')
        : t('discussion.report.noDelta'),
    })

    result.push({
      title: DELTA_SECTIONS[1]!,
      content: changedMembers.length > 0
        ? changedMembers.map((m) => `${m.agentName}:\n  Before: ${m.initialPosition}\n  After: ${m.finalPosition}`).join('\n')
        : t('discussion.report.noChange'),
    })

    result.push({
      title: DELTA_SECTIONS[2]!,
      content: unchangedMembers.length > 1
        ? unchangedMembers.map((m) => `${m.agentName}: ${m.finalPosition}`).join('\n')
        : t('discussion.report.noDisagreement'),
    })

    result.push({
      title: DELTA_SECTIONS[3]!,
      content: t('discussion.report.recommendationHint'),
    })

    result.push({
      title: DELTA_SECTIONS[4]!,
      content: t('discussion.report.nextActionsHint'),
    })

    return result
  }, [group, t])

  const toggleSection = (idx: number) => {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  return (
    <div className="border-t border-border">
      <div className="px-4 py-2">
        <h4 className="text-xs font-semibold text-pri">{t('discussion.report.title')}</h4>
      </div>
      {sections.map((section, idx) => (
        <div key={section.title} className="border-t border-border/50">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-1.5 text-left text-xs font-medium text-sec hover:bg-surface-secondary"
            onClick={() => toggleSection(idx)}
          >
            <span>{idx + 1}. {section.title}</span>
            <span>{expandedSections.has(idx) ? '−' : '+'}</span>
          </button>
          {expandedSections.has(idx) ? (
            <pre className="whitespace-pre-wrap px-4 pb-2 text-xs leading-relaxed text-ter">
              {section.content}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  )
}
