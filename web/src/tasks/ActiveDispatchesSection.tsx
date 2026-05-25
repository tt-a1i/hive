import { ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react'
import { useState } from 'react'

import { useI18n } from '../i18n.js'
import type { DispatchItem } from './useTasksApi.js'

export const ActiveDispatchesSection = ({ dispatches }: { dispatches: DispatchItem[] }) => {
  const { t } = useI18n()
  const active = dispatches.filter((d) => d.state === 'queued' || d.state === 'submitted')
  const [expanded, setExpanded] = useState(true)

  if (active.length === 0) return null

  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-testid="active-dispatches-toggle"
        className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ter"
      >
        {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <CornerDownRight size={12} aria-hidden />
        <span>{t('tasks.dispatches.active', { count: active.length })}</span>
      </button>
      {expanded ? (
        <ul className="flex flex-col gap-1 pl-4 text-xs text-sec" data-testid="active-dispatches-list">
          {active.map((d) => {
            const agentName = d.to_agent_id.split(':').pop() ?? d.to_agent_id
            return (
              <li key={d.id} className="flex items-center gap-1.5 truncate">
                <span className="dispatch-badge" data-tone={d.state === 'queued' ? 'orange' : 'blue'}>
                  {d.state}
                </span>
                <span className="font-medium">@{agentName}:</span>
                <span className="truncate">{d.text.slice(0, 60)}</span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
