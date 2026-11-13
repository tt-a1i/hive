import * as Dialog from '@radix-ui/react-dialog'
import {
  Archive,
  ChevronDown,
  Database,
  Eye,
  EyeOff,
  Loader2,
  Pin,
  PinOff,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  archiveWorkspaceMemoryEntry,
  type DreamRun,
  listWorkspaceMemory,
  listWorkspaceMemoryDreamRuns,
  type MemoryEntry,
  type MemoryStatus,
  revertWorkspaceMemoryDreamRun,
  runWorkspaceMemoryDream,
  updateWorkspaceMemoryEntry,
} from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'

type MemoryTab = 'active' | 'archived' | 'dreams'

interface WorkspaceMemoryDrawerProps {
  open: boolean
  onClose: () => void
  workspaceId: string | null
}

const KIND_LABELS: Record<MemoryEntry['kind'], TranslationKey> = {
  decision: 'memory.kind.decision',
  fact: 'memory.kind.fact',
  pitfall: 'memory.kind.pitfall',
  preference: 'memory.kind.preference',
  procedure_ref: 'memory.kind.procedure_ref',
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
})

const formatTime = (value: number | null, t: ReturnType<typeof useI18n>['t']) =>
  value ? dateTime.format(new Date(value)) : t('common.never')

const truncate = (value: string, max = 140) => {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

const sourceLabel = (memory: MemoryEntry) => {
  const source = memory.sources[0]
  if (!source?.actorNameSnapshot) return memory.source
  return `${memory.source} · ${source.actorNameSnapshot}`
}

const statusForTab = (tab: MemoryTab): MemoryStatus | null => (tab === 'dreams' ? null : tab)

const MemoryRow = ({
  busy,
  memory,
  onArchive,
  onToggleDisabled,
  onTogglePinned,
}: {
  busy: boolean
  memory: MemoryEntry
  onArchive: (memory: MemoryEntry) => void
  onToggleDisabled: (memory: MemoryEntry) => void
  onTogglePinned: (memory: MemoryEntry) => void
}) => {
  const [expanded, setExpanded] = useState(false)
  const { t } = useI18n()
  return (
    <li
      className="drawer-card memory-card"
      data-testid={`memory-row-${memory.id}`}
      data-pinned={memory.pinned}
      data-disabled={memory.disabled}
    >
      <div className="memory-card__layout">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="memory-card__main focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <div className="memory-card__eyebrow">
            <span className={`drawer-kind-badge drawer-kind-badge--${memory.kind}`}>
              {t(KIND_LABELS[memory.kind])}
            </span>
            {memory.pinned ? (
              <span className="memory-state memory-state--pinned">{t('memory.pinned')}</span>
            ) : null}
            {memory.scope === 'user' ? (
              <span className="memory-state">{t('memory.scopeUser')}</span>
            ) : null}
            {memory.disabled ? <span className="memory-state">{t('memory.disabled')}</span> : null}
            <span className="memory-card__source">{sourceLabel(memory)}</span>
          </div>
          <p className="memory-card__body">{expanded ? memory.body : truncate(memory.body)}</p>
          <div className="memory-card__meta">
            {memory.tags.map((tag) => (
              <span key={tag} className="drawer-tag">
                {tag}
              </span>
            ))}
            <span className="memory-card__time">
              {t('memory.updated', { time: formatTime(memory.updatedAt, t) })}
            </span>
            <span className="memory-card__time">
              {t('memory.injected', { time: formatTime(memory.lastInjectedAt, t) })}
            </span>
            {memory.procedureRef ? (
              <span className="memory-card__reference">{`${memory.procedureRef.type}: ${
                memory.procedureRef.title ?? memory.procedureRef.id
              }`}</span>
            ) : null}
          </div>
        </button>
        <div className="drawer-card__actions memory-card__actions">
          {memory.status === 'active' ? (
            <>
              <Tooltip label={memory.pinned ? t('memory.unpinTooltip') : t('memory.pinTooltip')}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onTogglePinned(memory)}
                  aria-label={memory.pinned ? t('memory.unpinTooltip') : t('memory.pinTooltip')}
                  className="icon-btn pointer-coarse:min-h-10 pointer-coarse:min-w-10"
                >
                  {memory.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                </button>
              </Tooltip>
              <Tooltip
                label={memory.disabled ? t('memory.enableTooltip') : t('memory.disableTooltip')}
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onToggleDisabled(memory)}
                  aria-label={
                    memory.disabled ? t('memory.enableTooltip') : t('memory.disableTooltip')
                  }
                  className="icon-btn pointer-coarse:min-h-10 pointer-coarse:min-w-10"
                >
                  {memory.disabled ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              </Tooltip>
              <Tooltip label={t('memory.archiveButton')}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onArchive(memory)}
                  aria-label={t('memory.archiveButton')}
                  className="icon-btn icon-btn--danger pointer-coarse:min-h-10 pointer-coarse:min-w-10"
                >
                  <Archive size={13} />
                </button>
              </Tooltip>
            </>
          ) : null}
          <span className="memory-card__disclosure" data-expanded={expanded || undefined}>
            <ChevronDown size={14} />
          </span>
        </div>
      </div>
      {expanded ? (
        <div className="drawer-card__expanded">
          <h4 className="drawer-section-label">{t('memory.sources')}</h4>
          {memory.sources.length === 0 ? (
            <p className="text-ter">{t('memory.noSources')}</p>
          ) : (
            <ul className="space-y-2">
              {memory.sources.map((source) => (
                <li key={source.id} className="break-words">
                  <div className="text-ter">
                    {source.sourceType}
                    {source.actorNameSnapshot ? ` · ${source.actorNameSnapshot}` : ''}
                    {source.actorRoleSnapshot ? ` · ${source.actorRoleSnapshot}` : ''}
                  </div>
                  {source.excerpt ? <p className="mt-0.5">{source.excerpt}</p> : null}
                  {source.sourceType === 'memory' && source.sourceId ? (
                    <code className="text-ter">{source.sourceId}</code>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  )
}

const dreamCounts = (run: DreamRun, t: ReturnType<typeof useI18n>['t']) => {
  if (!run.report)
    return run.error ? `${t('common.error')} · ${truncate(run.error, 90)}` : t('memory.noReport')
  return [
    `${run.report.added.length} ${t('memory.reportAdded')}`,
    `${run.report.rewritten.length} ${t('memory.reportRewritten')}`,
    `${run.report.archived.length} ${t('memory.reportArchived')}`,
    `${run.report.merged.length} ${t('memory.reportMerged')}`,
  ].join(' · ')
}

const dreamWindow = (run: DreamRun, t: ReturnType<typeof useI18n>['t']) =>
  run.inputSeqFrom === null || run.inputSeqTo === null
    ? t('memory.noInput')
    : `${t('memory.seq')} ${run.inputSeqFrom}-${run.inputSeqTo}`

const DreamRunRow = ({
  busy,
  onRevert,
  run,
}: {
  busy: boolean
  onRevert: (run: DreamRun) => void
  run: DreamRun
}) => {
  const [expanded, setExpanded] = useState(false)
  const { t } = useI18n()
  return (
    <li
      className="drawer-card memory-card memory-dream-card"
      data-testid={`dream-run-${run.id}`}
      data-dream-status={run.status}
    >
      <div className="memory-card__layout">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="memory-card__main focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <div className="memory-card__eyebrow">
            <span className={`drawer-status-badge drawer-status-badge--${run.status}`}>
              {t(`memory.status.${run.status}` as TranslationKey)}
            </span>
            <span className="text-ter">{t(`memory.trigger.${run.trigger}` as TranslationKey)}</span>
            <span className="text-ter">{dreamWindow(run, t)}</span>
            <span className="text-ter">
              {t('memory.started', { time: formatTime(run.startedAt, t) })}
            </span>
          </div>
          <p className="memory-card__body">{dreamCounts(run, t)}</p>
          {run.finishedAt ? (
            <p className="mt-1 text-[11px] text-ter">
              {t('memory.finished', { time: formatTime(run.finishedAt, t) })}
            </p>
          ) : null}
        </button>
        {run.status === 'completed' ? (
          <div className="drawer-card__actions memory-card__actions">
            <Tooltip label={t('memory.revertButton')}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRevert(run)}
                aria-label={t('memory.revertTooltip')}
                className="icon-btn icon-btn--danger pointer-coarse:min-h-10 pointer-coarse:min-w-10"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
      {expanded && run.report ? (
        <div className="drawer-card__expanded space-y-3">
          {run.report.added.length > 0 ? (
            <div className="dream-diff-block border-l-2 border-l-status-green">
              <h4 className="dream-diff-title dream-diff-added flex items-center gap-1.5 font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-status-green" />
                {t('memory.diff.added')}
              </h4>
              <ul className="space-y-1.5 mt-1.5">
                {run.report.added.map((entry) => (
                  <li
                    key={entry.id}
                    className="break-words text-[11px] text-pri flex items-start gap-1"
                  >
                    <span className="text-status-green select-none font-semibold mr-1">+</span>
                    <span className="flex-1">
                      <span
                        className={`drawer-kind-badge drawer-kind-badge--${entry.kind} scale-90 origin-left inline-block mr-1`}
                      >
                        {t(KIND_LABELS[entry.kind] as TranslationKey)}
                      </span>
                      {entry.body}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.report.rewritten.length > 0 ? (
            <div className="dream-diff-block border-l-2 border-l-[#f59e0b]">
              <h4 className="dream-diff-title dream-diff-rewritten flex items-center gap-1.5 font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b]" />
                {t('memory.diff.rewritten')}
              </h4>
              <p className="mt-1.5 text-[11px] text-sec leading-relaxed pl-3 break-all">
                {run.report.rewritten.map((entry) => entry.id).join(', ')}
              </p>
            </div>
          ) : null}
          {run.report.archived.length > 0 ? (
            <div className="dream-diff-block border-l-2 border-l-status-red">
              <h4 className="dream-diff-title dream-diff-archived flex items-center gap-1.5 font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-status-red" />
                {t('memory.diff.archived')}
              </h4>
              <p className="mt-1.5 text-[11px] text-sec leading-relaxed pl-3 break-all">
                {run.report.archived.map((entry) => entry.id).join(', ')}
              </p>
            </div>
          ) : null}
          {run.report.merged.length > 0 ? (
            <div className="dream-diff-block border-l-2 border-l-purple-500">
              <h4 className="dream-diff-title dream-diff-merged flex items-center gap-1.5 font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                {t('memory.diff.merged')}
              </h4>
              <p className="mt-1.5 text-[11px] text-sec leading-relaxed pl-3 break-all">
                {run.report.merged.map((entry) => entry.into).join(', ')}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      {expanded && run.error ? <p className="drawer-card__error">{run.error}</p> : null}
    </li>
  )
}

export const WorkspaceMemoryDrawer = ({
  open,
  onClose,
  workspaceId,
}: WorkspaceMemoryDrawerProps) => {
  const isMobile = useIsMobile()
  const { t } = useI18n()
  const [tab, setTab] = useState<MemoryTab>('active')
  const [query, setQuery] = useState('')
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [dreamRuns, setDreamRuns] = useState<DreamRun[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dreamBusyId, setDreamBusyId] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<MemoryEntry | null>(null)
  const [revertTarget, setRevertTarget] = useState<DreamRun | null>(null)
  const loadRequestId = useRef(0)

  const tabs = useMemo<Array<{ id: MemoryTab; label: string }>>(
    () => [
      { id: 'active', label: t('memory.tabActive') },
      { id: 'archived', label: t('memory.tabArchived') },
      { id: 'dreams', label: t('memory.tabDreams') },
    ],
    [t]
  )

  const status = statusForTab(tab)
  const load = useCallback(async () => {
    const requestId = loadRequestId.current + 1
    loadRequestId.current = requestId
    if (!workspaceId || !open) {
      setMemories([])
      setDreamRuns([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    setMemories([])
    setDreamRuns([])
    try {
      const [nextMemories, nextDreamRuns] = await Promise.all([
        status
          ? listWorkspaceMemory(workspaceId, {
              query,
              scope: 'all',
              status,
            })
          : Promise.resolve([]),
        status ? Promise.resolve([]) : listWorkspaceMemoryDreamRuns(workspaceId, { limit: 20 }),
      ])
      if (loadRequestId.current !== requestId) return
      setMemories(nextMemories)
      setDreamRuns(nextDreamRuns)
    } catch (loadError) {
      if (loadRequestId.current === requestId) {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    } finally {
      if (loadRequestId.current === requestId) setLoading(false)
    }
  }, [open, query, status, workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  const runMemoryAction = async (
    memory: MemoryEntry,
    action: (workspaceId: string) => Promise<MemoryEntry>
  ) => {
    if (!workspaceId) return
    setBusyId(memory.id)
    setError(null)
    try {
      await action(workspaceId)
      await load()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusyId(null)
    }
  }

  const counts = useMemo(
    () => ({
      current: status ? memories.length : dreamRuns.length,
    }),
    [dreamRuns.length, memories.length, status]
  )

  const runDreamNow = async () => {
    if (!workspaceId) return
    setDreamBusyId('run-now')
    setError(null)
    try {
      await runWorkspaceMemoryDream(workspaceId)
      await load()
    } catch (dreamError) {
      setError(dreamError instanceof Error ? dreamError.message : String(dreamError))
    } finally {
      setDreamBusyId(null)
    }
  }

  const revertDreamRun = async (run: DreamRun) => {
    if (!workspaceId) return
    setDreamBusyId(run.id)
    setError(null)
    try {
      await revertWorkspaceMemoryDreamRun(workspaceId, run.id)
      await load()
    } catch (dreamError) {
      setError(dreamError instanceof Error ? dreamError.message : String(dreamError))
    } finally {
      setDreamBusyId(null)
    }
  }

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay data-testid="memory-overlay" className="app-overlay fixed inset-0 z-40" />
          <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
            <Dialog.Content
              data-testid="memory-drawer"
              aria-label={t('memory.title')}
              data-mobile={isMobile || undefined}
              className="memory-drawer dialog-scale-pop elev-2 pointer-events-auto flex flex-col border"
              style={
                isMobile
                  ? { background: 'var(--bg-1)', borderColor: 'var(--border-bright)' }
                  : {
                      background: 'var(--bg-1)',
                      borderColor: 'var(--border-bright)',
                      height: 'min(720px, calc(100vh - 48px))',
                      width: 'min(780px, calc(100vw - 48px))',
                    }
              }
            >
              <header className="memory-drawer__header">
                <div className="memory-drawer__heading">
                  <div className="memory-drawer__mark" aria-hidden>
                    <Sparkles size={17} />
                  </div>
                  <div className="min-w-0">
                    <Dialog.Title className="memory-drawer__title">
                      {t('memory.title')}
                    </Dialog.Title>
                    <p className="memory-drawer__subtitle">{t('memory.subtitle')}</p>
                  </div>
                </div>
                <Tooltip label={t('common.close')}>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('common.close')}
                    className="icon-btn pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                  >
                    <X size={14} />
                  </button>
                </Tooltip>
              </header>

              <div
                className={`memory-drawer__toolbar ${isMobile ? 'memory-drawer__toolbar--mobile' : ''}`}
              >
                <div
                  className="drawer-tabs"
                  style={isMobile ? { width: '100%', justifyContent: 'flex-start' } : undefined}
                >
                  {tabs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      aria-pressed={tab === item.id}
                      className={`drawer-tab pointer-coarse:min-h-10 ${
                        tab === item.id ? 'drawer-tab--active' : ''
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {status ? (
                  <label
                    className="drawer-search memory-search"
                    style={isMobile ? { width: '100%', maxWidth: 'none' } : { marginLeft: 'auto' }}
                  >
                    <span className="sr-only">{t('memory.searchPlaceholder')}</span>
                    <Search
                      size={14}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ter"
                    />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.currentTarget.value)}
                      placeholder={t('memory.searchPlaceholder')}
                      name="memory-search"
                      autoComplete="off"
                      className="memory-search__input"
                    />
                  </label>
                ) : null}
              </div>

              <div className="memory-drawer__content scroll-y min-h-0 flex-1">
                {error ? (
                  <div
                    className="mb-3 rounded-md border px-3 py-2 text-xs"
                    style={{
                      borderColor: 'color-mix(in oklab, var(--status-red) 30%, var(--border))',
                      color: 'var(--text-error)',
                      background: 'color-mix(in oklab, var(--status-red) 8%, transparent)',
                    }}
                  >
                    {error}
                  </div>
                ) : null}

                <section className="memory-summary">
                  <div className="memory-summary__label">
                    <span className="memory-summary__icon">
                      <Database size={13} />
                    </span>
                    <span>
                      {counts.current} {status ? t('memory.entries') : t('memory.runs')}
                    </span>
                  </div>
                  {tab === 'dreams' ? (
                    <button
                      type="button"
                      onClick={runDreamNow}
                      disabled={dreamBusyId !== null}
                      className="drawer-action-btn pointer-coarse:min-h-10"
                    >
                      {dreamBusyId === 'run-now' ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      {t('memory.runNow')}
                    </button>
                  ) : null}
                </section>

                {tab === 'dreams' ? (
                  loading ? (
                    <div className="flex h-[320px] items-center justify-center text-ter">
                      <Loader2 size={18} className="animate-spin" />
                      <span className="ml-2 text-sm">{t('common.loading')}</span>
                    </div>
                  ) : dreamRuns.length === 0 ? (
                    <div className="flex h-[320px] items-center justify-center">
                      <EmptyState
                        icon={<Sparkles size={20} />}
                        title={t('memory.emptyDreams')}
                        description={t('memory.emptyDreamsDesc')}
                      />
                    </div>
                  ) : (
                    <ul className="memory-list">
                      {dreamRuns.map((run) => (
                        <DreamRunRow
                          key={run.id}
                          run={run}
                          busy={dreamBusyId === run.id}
                          onRevert={setRevertTarget}
                        />
                      ))}
                    </ul>
                  )
                ) : loading ? (
                  <div className="flex h-[320px] items-center justify-center text-ter">
                    <Loader2 size={18} className="animate-spin" />
                    <span className="ml-2 text-sm">{t('common.loading')}</span>
                  </div>
                ) : memories.length === 0 ? (
                  <div className="flex h-[320px] items-center justify-center">
                    <EmptyState
                      title={t('memory.emptyActive')}
                      description={t('memory.emptyActiveDesc')}
                    />
                  </div>
                ) : (
                  <ul className="memory-list">
                    {memories.map((memory) => (
                      <MemoryRow
                        key={memory.id}
                        memory={memory}
                        busy={busyId === memory.id}
                        onArchive={setArchiveTarget}
                        onToggleDisabled={(entry) =>
                          runMemoryAction(entry, (currentWorkspaceId) =>
                            updateWorkspaceMemoryEntry(currentWorkspaceId, entry.id, {
                              disabled: !entry.disabled,
                            })
                          )
                        }
                        onTogglePinned={(entry) =>
                          runMemoryAction(entry, (currentWorkspaceId) =>
                            updateWorkspaceMemoryEntry(currentWorkspaceId, entry.id, {
                              pinned: !entry.pinned,
                            })
                          )
                        }
                      />
                    ))}
                  </ul>
                )}
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
      <Confirm
        open={archiveTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setArchiveTarget(null)
        }}
        title={t('memory.archiveTitle')}
        description={t('memory.archiveDesc')}
        confirmLabel={t('memory.archiveButton')}
        confirmKind="danger"
        onConfirm={() => {
          if (!archiveTarget) return
          const target = archiveTarget
          setArchiveTarget(null)
          void runMemoryAction(target, (currentWorkspaceId) =>
            archiveWorkspaceMemoryEntry(currentWorkspaceId, target.id)
          )
        }}
      />
      <Confirm
        open={revertTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRevertTarget(null)
        }}
        title={t('memory.revertTitle')}
        description={t('memory.revertDesc')}
        confirmLabel={t('memory.revertButton')}
        confirmKind="danger"
        onConfirm={() => {
          if (!revertTarget) return
          const target = revertTarget
          setRevertTarget(null)
          void revertDreamRun(target)
        }}
      />
    </>
  )
}
