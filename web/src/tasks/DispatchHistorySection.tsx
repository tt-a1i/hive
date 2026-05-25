import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { useI18n } from '../i18n.js'

import type { DispatchItem } from './useTasksApi.js'
import { useDispatchHistory } from './useTasksApi.js'

const formatRelativeTime = (ts: number): string => {
  const diff = Date.now() - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '<1m'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

const truncate = (text: string, max = 50) =>
  text.length <= max ? text : `${text.slice(0, max)}…`

const HistoryRow = ({ item }: { item: DispatchItem }) => {
  const time = item.reported_at ?? item.created_at
  return (
    <li className="flex items-center gap-2 py-1 text-xs">
      <span className="shrink-0" aria-label={item.state === 'reported' ? 'completed' : 'cancelled'}>
        {item.state === 'reported' ? '✓' : '✗'}
      </span>
      <span className="min-w-0 flex-1 truncate text-sec" title={item.text}>
        <span className="font-medium text-pri">{item.to_agent_id}</span>
        {' — '}
        {truncate(item.report_text || item.text)}
      </span>
      <span className="shrink-0 text-ter">{formatRelativeTime(time)}</span>
    </li>
  )
}

export const DispatchHistorySection = ({ workspaceId }: { workspaceId: string | null }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const { items, loading, hasMore, loadMore } = useDispatchHistory(open ? workspaceId : null)

  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="dispatch-history-toggle"
        className="flex w-full items-center gap-1.5 text-xs font-medium text-ter hover:text-sec"
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <span>{t('tasks.dispatchHistory.title')}</span>
      </button>
      {open ? (
        <div className="mt-2">
          {items.length === 0 && !loading ? (
            <p className="px-4 text-xs text-ter">{t('tasks.dispatchHistory.empty')}</p>
          ) : (
            <ul className="flex flex-col pl-2" data-testid="dispatch-history-list">
              {items.map((item) => (
                <HistoryRow key={item.id} item={item} />
              ))}
            </ul>
          )}
          {hasMore && !loading ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              data-testid="dispatch-history-load-more"
              className="mt-1.5 px-2 text-xs text-accent hover:underline"
            >
              {t('tasks.dispatchHistory.loadMore')}
            </button>
          ) : null}
          {loading ? (
            <p className="mt-1.5 px-2 text-xs text-ter">{t('common.loading')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
