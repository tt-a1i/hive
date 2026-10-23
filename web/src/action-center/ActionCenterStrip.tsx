import * as Dialog from '@radix-ui/react-dialog'
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  FileText,
  LoaderCircle,
  Radio,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
  type ActionCenterActivity,
  type ActionCenterAttention,
  type ActionCenterSummary,
  type ActionCenterWorkerEvidence,
  getActionCenterSummary,
  getTeamRecap,
} from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'
import { copyPendingTextToClipboard } from '../lib/clipboard.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useToast } from '../ui/useToast.js'
import { ActionCenterMessages, type MessageRequest } from './ActionCenterMessages.js'
import { ActionCenterReport } from './ActionCenterReport.js'

const POLL_INTERVAL_MS = 2000

// Function call (not direct property access) so TS doesn't narrow the value
// across awaits — visibility genuinely changes while a fetch is in flight.
const isPageHidden = () => document.visibilityState === 'hidden'

type ActionCenterProps = {
  onOpenWorker?: (workerId: string) => void
  workspaceId: string
}

const relativeTime = (ts: number, t: ReturnType<typeof useI18n>['t']): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) return t('common.time.sAgo', { count: seconds })
  if (seconds < 3600) return t('common.time.mAgo', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('common.time.hAgo', { count: Math.floor(seconds / 3600) })
  return t('common.time.dAgo', { count: Math.floor(seconds / 86400) })
}

const activityKey: Record<ActionCenterActivity['kind'], TranslationKey> = {
  cancelled: 'actionCenter.activity.cancelled',
  queued: 'actionCenter.activity.queued',
  reported: 'actionCenter.activity.reported',
  submitted: 'actionCenter.activity.submitted',
}

const describeActivity = (activity: ActionCenterActivity, t: ReturnType<typeof useI18n>['t']) => {
  const worker = activity.toWorkerName ?? t('actionCenter.unknownWorker')
  return t(activityKey[activity.kind], { ago: relativeTime(activity.timestamp, t), worker })
}

const activityDetail = (activity: ActionCenterActivity): string | null =>
  activity.reportPreview ?? activity.taskPreview ?? activity.label ?? activity.phase

const workerEvidenceText = (worker: ActionCenterWorkerEvidence): string | null =>
  worker.currentDispatch?.taskPreview ??
  worker.latestReport?.reportPreview ??
  worker.terminalHint ??
  null

const workerEvidenceLabel = (
  worker: ActionCenterWorkerEvidence,
  t: ReturnType<typeof useI18n>['t']
): string => {
  if (worker.currentDispatch) return t('actionCenter.currentDispatch')
  if (worker.latestReport) return t('actionCenter.latestReport')
  if (worker.terminalHint) return t('actionCenter.terminalHint')
  return t('actionCenter.workerStatus')
}

const attentionText = (item: ActionCenterAttention, t: ReturnType<typeof useI18n>['t']): string => {
  if ('messageId' in item) {
    return t(
      item.kind === 'question_waiting_answer'
        ? 'actionCenter.message.questionWaiting'
        : 'actionCenter.message.deliveryFailed',
      { dispatch: item.dispatchId.slice(0, 8) }
    )
  }
  if (item.kind === 'no_workers') return t('actionCenter.attention.noWorkers')
  if (item.kind === 'stopped_with_queue') {
    return t('actionCenter.attention.stoppedWithQueue', { worker: item.workerName })
  }
  if (item.kind === 'dispatch_waiting_report') {
    return t('actionCenter.attention.waitingReport', {
      minutes: item.minutesAgo,
      worker: item.workerName ?? t('actionCenter.unknownWorker'),
    })
  }
  return t(
    item.kind === 'remote_error'
      ? 'actionCenter.attention.remoteError'
      : 'actionCenter.attention.remoteRejected',
    {
      endpoint: item.endpoint ?? item.action,
      reason: item.reason ?? 'unknown',
    }
  )
}

const attentionKey = (item: ActionCenterAttention): string => {
  if (item.kind === 'question_waiting_answer' || item.kind === 'message_delivery_pending')
    return `${item.kind}-${item.messageId}`
  if (item.kind === 'stopped_with_queue') return `${item.kind}-${item.workerId}`
  if (item.kind === 'dispatch_waiting_report') return `${item.kind}-${item.dispatchId}`
  if (item.kind === 'remote_error' || item.kind === 'remote_rejected') {
    return `${item.kind}-${item.ts}-${item.action}-${item.endpoint ?? ''}-${item.reason ?? ''}`
  }
  return item.kind
}

const useActionCenterSummary = (workspaceId: string) => {
  const [summary, setSummary] = useState<ActionCenterSummary | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      return getActionCenterSummary(workspaceId, signal ? { signal } : undefined)
    },
    [workspaceId]
  )

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let controller: AbortController | null = null

    const tick = async () => {
      // Hidden tabs stop the chain entirely instead of polling into the void —
      // from a paired phone every poll crosses the E2E tunnel. The
      // visibilitychange handler restarts it.
      if (cancelled || inFlight || isPageHidden()) return
      inFlight = true
      controller = new AbortController()
      try {
        const next = await load(controller.signal)
        if (cancelled) return
        setSummary(next)
        setError(false)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        controller = null
        inFlight = false
      }
      if (!cancelled && !isPageHidden()) {
        timer = setTimeout(tick, POLL_INTERVAL_MS)
      }
    }

    const handleVisibility = () => {
      if (cancelled || isPageHidden()) return
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      void tick()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    void tick()
    return () => {
      cancelled = true
      controller?.abort()
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [load])

  return { error, summary: summary?.workspaceId === workspaceId ? summary : null }
}

const useRecapCopy = (workspaceId: string) => {
  const { t } = useI18n()
  const toast = useToast()
  const [copyingRecap, setCopyingRecap] = useState(false)

  const handleCopyRecap = () => {
    if (copyingRecap) return
    setCopyingRecap(true)
    // Kick off the fetch and hand the still-pending text to the clipboard
    // helper synchronously: Safari revokes clipboard access at the first
    // await inside the click gesture, so never `await fetch` before copying.
    const pendingMarkdown = getTeamRecap(workspaceId).then((recap) => recap.markdown)
    copyPendingTextToClipboard(pendingMarkdown)
      .then(() => toast.show({ kind: 'success', message: t('actionCenter.recapCopied') }))
      .catch(() => toast.show({ kind: 'error', message: t('actionCenter.recapCopyFailed') }))
      .finally(() => setCopyingRecap(false))
  }

  return { copyingRecap, handleCopyRecap }
}

const getActionCenterView = (summary: ActionCenterSummary | null) => {
  const latest = summary?.recentActivity[0] ?? null
  const latestDetail = latest ? activityDetail(latest) : null
  const attention = summary?.attention.slice(0, 5) ?? []
  const evidenceWorkers =
    summary?.workers
      .filter(
        (worker) =>
          worker.currentDispatch ||
          worker.latestReport ||
          worker.terminalHint ||
          worker.status === 'working'
      )
      .slice(0, 6) ?? []
  const recentActivity = summary?.recentActivity.slice(0, 6) ?? []

  return {
    attention,
    evidenceWorkers,
    latest,
    latestDetail,
    recentActivity,
  }
}

const activityTone = (kind: ActionCenterActivity['kind']) => {
  if (kind === 'reported') return 'green'
  if (kind === 'cancelled') return 'red'
  if (kind === 'queued') return 'orange'
  return 'accent'
}

const ActionCenterDetails = ({
  copyingRecap,
  onCopyRecap,
  onOpenWorker,
  summary,
}: {
  copyingRecap: boolean
  onCopyRecap: () => void
  onOpenWorker?: (workerId: string) => void
  summary: ActionCenterSummary
}) => {
  const { t } = useI18n()
  const { attention, evidenceWorkers, recentActivity } = getActionCenterView(summary)
  const [messageRequest, setMessageRequest] = useState<MessageRequest | null>(null)
  const [reportDispatchId, setReportDispatchId] = useState<string | null>(null)

  return (
    <div className="mt-2 grid gap-2 md:grid-cols-2" data-testid="action-center-evidence">
      {reportDispatchId ? (
        <div className="md:col-span-2">
          <ActionCenterReport
            key={reportDispatchId}
            workspaceId={summary.workspaceId}
            dispatchId={reportDispatchId}
            onClose={() => setReportDispatchId(null)}
            onOpenHistory={(dispatchId) => setMessageRequest({ dispatchId })}
            {...(onOpenWorker ? { onOpenWorker } : {})}
          />
        </div>
      ) : null}
      <div className="md:col-span-2">
        <ActionCenterMessages
          key={summary.workspaceId}
          workspaceId={summary.workspaceId}
          messages={summary.recentDispatchMessages}
          workers={summary.workers}
          request={messageRequest}
        />
      </div>
      <div className="flex min-w-0 justify-end md:col-span-2">
        <button
          type="button"
          onClick={onCopyRecap}
          disabled={copyingRecap}
          className="inline-flex items-center gap-1.5 rounded border border-bright/40 px-2 py-1 text-xs text-sec hover:bg-2 hover:text-pri disabled:cursor-default disabled:opacity-60"
          data-testid="action-center-copy-recap"
        >
          <Copy size={12} aria-hidden />
          {t('actionCenter.copyRecap')}
        </button>
      </div>
      {attention.length > 0 ? (
        <div className="min-w-0 md:col-span-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ter">
            {t('actionCenter.attention')}
          </div>
          <ul className="flex flex-col gap-px rounded border border-bright/40 bg-0">
            {attention.map((item) => (
              <li key={attentionKey(item)}>
                <div
                  className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-xs"
                  data-testid={`action-center-attention-${attentionKey(item)}`}
                >
                  <span
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background:
                        item.severity === 'error'
                          ? 'var(--status-red)'
                          : item.severity === 'warning'
                            ? 'var(--status-orange)'
                            : 'var(--text-tertiary)',
                    }}
                    aria-hidden
                  />
                  <span className="min-w-0 truncate text-sec" title={attentionText(item, t)}>
                    {'messageId' in item ? (
                      <button
                        type="button"
                        className="text-left underline decoration-dotted underline-offset-2"
                        onClick={() =>
                          setMessageRequest({
                            dispatchId: item.dispatchId,
                            messageId: item.messageId,
                          })
                        }
                      >
                        {attentionText(item, t)}
                      </button>
                    ) : (
                      attentionText(item, t)
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="min-w-0">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ter">
          {t('actionCenter.recent')}
        </div>
        {recentActivity.length > 0 ? (
          <ul className="flex max-h-36 flex-col gap-px overflow-auto rounded border border-bright/40 bg-0">
            {recentActivity.map((activity) => {
              const detail = activityDetail(activity)
              return (
                <li key={activity.id}>
                  <button
                    type="button"
                    onClick={() =>
                      activity.kind === 'reported'
                        ? setReportDispatchId(activity.id)
                        : onOpenWorker?.(activity.toAgentId)
                    }
                    className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-2 disabled:cursor-default disabled:hover:bg-transparent"
                    disabled={activity.kind !== 'reported' && !onOpenWorker}
                    data-testid={`action-center-activity-${activity.id}`}
                  >
                    <span className="shrink-0 text-sec">{describeActivity(activity, t)}</span>
                    {detail ? (
                      <span className="min-w-0 truncate text-ter" title={detail}>
                        {detail}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="rounded border border-dashed border-bright/40 px-2 py-2 text-xs text-ter">
            {t('actionCenter.noActivity')}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ter">
          {t('actionCenter.workers')}
        </div>
        {evidenceWorkers.length > 0 ? (
          <ul className="flex max-h-36 flex-col gap-px overflow-auto rounded border border-bright/40 bg-0">
            {evidenceWorkers.map((worker) => {
              const evidence = workerEvidenceText(worker)
              return (
                <li key={worker.id}>
                  <button
                    type="button"
                    onClick={() => onOpenWorker?.(worker.id)}
                    className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-2 disabled:cursor-default disabled:hover:bg-transparent"
                    disabled={!onOpenWorker}
                    data-testid={`action-center-worker-${worker.id}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-sec">{worker.name}</span>
                    <span className="shrink-0 text-ter">{workerEvidenceLabel(worker, t)}</span>
                    {evidence ? (
                      <span className="min-w-0 flex-[1.4] truncate text-ter" title={evidence}>
                        {evidence}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="rounded border border-dashed border-bright/40 px-2 py-2 text-xs text-ter">
            {t('actionCenter.noWorkerEvidence')}
          </div>
        )}
      </div>
    </div>
  )
}

const MetricCard = ({
  icon,
  label,
  tone = 'neutral',
  value,
}: {
  icon: ReactNode
  label: string
  tone?: 'accent' | 'green' | 'neutral' | 'orange'
  value: number
}) => (
  <div className="action-center-metric" data-tone={tone}>
    <div className="action-center-metric__icon" aria-hidden>
      {icon}
    </div>
    <div className="min-w-0">
      <div className="mono text-lg font-semibold leading-none text-pri">{value}</div>
      <div className="mt-1 truncate text-[11px] font-medium text-ter">{label}</div>
    </div>
  </div>
)

const ActionCenterDrawer = ({
  copyingRecap,
  error,
  onClose,
  onCopyRecap,
  onOpenWorker,
  open,
  summary,
}: {
  copyingRecap: boolean
  error: boolean
  onClose: () => void
  onCopyRecap: () => void
  onOpenWorker?: (workerId: string) => void
  open: boolean
  summary: ActionCenterSummary | null
}) => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [messageRequest, setMessageRequest] = useState<MessageRequest | null>(null)
  const [reportDispatchId, setReportDispatchId] = useState<string | null>(null)
  const { attention, evidenceWorkers, latest, latestDetail, recentActivity } =
    getActionCenterView(summary)
  const handleOpenWorker = (workerId: string) => {
    onOpenWorker?.(workerId)
    onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="action-center-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="action-center-drawer"
            aria-label={t('actionCenter.title')}
            data-mobile={isMobile || undefined}
            className="dialog-scale-pop elev-2 pointer-events-auto flex flex-col rounded-lg border"
            style={
              isMobile
                ? { background: 'var(--bg-1)', borderColor: 'var(--border-bright)' }
                : {
                    background: 'var(--bg-1)',
                    borderColor: 'var(--border-bright)',
                    height: 'min(720px, calc(100vh - 48px))',
                    width: 'min(820px, calc(100vw - 48px))',
                  }
            }
          >
            <header
              className="flex items-center justify-between gap-3 border-b px-4 py-2"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="min-w-0">
                <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-pri">
                  <Activity size={17} className="text-accent" aria-hidden />
                  {t('actionCenter.title')}
                </Dialog.Title>
                <Dialog.Description className="text-xs text-ter">
                  {t('actionCenter.subtitle')}
                </Dialog.Description>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Tooltip label={t('actionCenter.copyRecap')}>
                  <button
                    type="button"
                    onClick={onCopyRecap}
                    disabled={copyingRecap || !summary}
                    className="drawer-action-btn pointer-coarse:min-h-10"
                    data-testid="action-center-copy-recap"
                  >
                    {copyingRecap ? (
                      <LoaderCircle size={14} className="animate-spin" />
                    ) : (
                      <Copy size={14} />
                    )}
                    <span className="hidden sm:inline">{t('actionCenter.copyRecap')}</span>
                  </button>
                </Tooltip>
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
              </div>
            </header>

            <div className="scroll-y min-h-0 flex-1 px-4 py-4">
              {error ? (
                <div className="action-center-alert action-center-alert--error">
                  <AlertTriangle size={15} aria-hidden />
                  <span>{t('actionCenter.loadFailed')}</span>
                </div>
              ) : null}

              {!summary ? (
                <div className="flex h-[320px] items-center justify-center text-ter">
                  <LoaderCircle size={18} className="animate-spin" />
                  <span className="ml-2 text-sm">{t('actionCenter.loading')}</span>
                </div>
              ) : (
                <div className="space-y-4">
                  <section
                    className="action-center-hero"
                    data-state={attention.length > 0 ? 'attention' : 'calm'}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="action-center-kicker">
                          <Radio size={13} aria-hidden />
                          {t('actionCenter.liveSnapshot')}
                        </span>
                        <span className="text-[11px] text-ter">
                          {t('actionCenter.updated', {
                            ago: relativeTime(summary.generatedAt, t),
                          })}
                        </span>
                      </div>
                      <p className="mt-2 text-sm font-medium text-pri">
                        {latest ? describeActivity(latest, t) : t('actionCenter.noActivity')}
                      </p>
                      {latestDetail ? (
                        <p className="mt-1 line-clamp-2 text-xs text-sec" title={latestDetail}>
                          {latestDetail}
                        </p>
                      ) : null}
                    </div>
                    <div className="action-center-hero__status">
                      {attention.length > 0
                        ? t('actionCenter.needsAttention', { count: attention.length })
                        : t('actionCenter.allClear')}
                    </div>
                  </section>

                  <section
                    className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
                    aria-label={t('actionCenter.metrics')}
                  >
                    <MetricCard
                      icon={<Users size={15} />}
                      label={t('actionCenter.totalWorkers')}
                      value={summary.summary.totalWorkers}
                    />
                    <MetricCard
                      icon={<Radio size={15} />}
                      label={t('actionCenter.workingWorkers')}
                      tone="green"
                      value={summary.summary.workingWorkers}
                    />
                    <MetricCard
                      icon={<Clock3 size={15} />}
                      label={t('actionCenter.openDispatches')}
                      tone={summary.summary.openDispatches > 0 ? 'orange' : 'neutral'}
                      value={summary.summary.openDispatches}
                    />
                    <MetricCard
                      icon={<FileText size={15} />}
                      label={t('actionCenter.recentReports')}
                      tone="accent"
                      value={summary.summary.recentReports}
                    />
                  </section>

                  {reportDispatchId ? (
                    <ActionCenterReport
                      key={reportDispatchId}
                      workspaceId={summary.workspaceId}
                      dispatchId={reportDispatchId}
                      onClose={() => setReportDispatchId(null)}
                      onOpenHistory={(dispatchId) => setMessageRequest({ dispatchId })}
                      {...(onOpenWorker ? { onOpenWorker: handleOpenWorker } : {})}
                    />
                  ) : null}
                  <ActionCenterMessages
                    key={summary.workspaceId}
                    workspaceId={summary.workspaceId}
                    messages={summary.recentDispatchMessages}
                    workers={summary.workers}
                    request={messageRequest}
                  />
                  <section className="grid gap-3 lg:grid-cols-[1fr_1fr]">
                    <div className="action-center-panel lg:col-span-2">
                      <div className="action-center-panel__header">
                        <div>
                          <h3>{t('actionCenter.attention')}</h3>
                          <p>{t('actionCenter.attentionSubtitle')}</p>
                        </div>
                      </div>
                      {attention.length > 0 ? (
                        <ul className="space-y-2">
                          {attention.map((item) => (
                            <li key={attentionKey(item)}>
                              <div
                                className="action-center-attention-row"
                                data-severity={item.severity}
                                data-testid={`action-center-attention-${attentionKey(item)}`}
                              >
                                <AlertTriangle size={14} aria-hidden />
                                <span className="min-w-0 flex-1 truncate">
                                  {'messageId' in item ? (
                                    <button
                                      type="button"
                                      className="text-left underline decoration-dotted underline-offset-2"
                                      onClick={() =>
                                        setMessageRequest({
                                          dispatchId: item.dispatchId,
                                          messageId: item.messageId,
                                        })
                                      }
                                    >
                                      {attentionText(item, t)}
                                    </button>
                                  ) : (
                                    attentionText(item, t)
                                  )}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="action-center-empty">{t('actionCenter.noAttention')}</div>
                      )}
                    </div>

                    <div className="action-center-panel">
                      <div className="action-center-panel__header">
                        <div>
                          <h3>{t('actionCenter.recent')}</h3>
                          <p>{t('actionCenter.recentSubtitle')}</p>
                        </div>
                      </div>
                      {recentActivity.length > 0 ? (
                        <ul className="space-y-1.5">
                          {recentActivity.map((activity) => {
                            const detail = activityDetail(activity)
                            return (
                              <li key={activity.id}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    activity.kind === 'reported'
                                      ? setReportDispatchId(activity.id)
                                      : handleOpenWorker(activity.toAgentId)
                                  }
                                  className="action-center-list-row"
                                  data-tone={activityTone(activity.kind)}
                                  disabled={activity.kind !== 'reported' && !onOpenWorker}
                                  data-testid={`action-center-activity-${activity.id}`}
                                >
                                  <span className="action-center-row-dot" aria-hidden />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-medium text-pri">
                                      {describeActivity(activity, t)}
                                    </span>
                                    {detail ? (
                                      <span className="block truncate text-[11px] text-ter">
                                        {detail}
                                      </span>
                                    ) : null}
                                  </span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      ) : (
                        <div className="action-center-empty">{t('actionCenter.noActivity')}</div>
                      )}
                    </div>

                    <div className="action-center-panel">
                      <div className="action-center-panel__header">
                        <div>
                          <h3>{t('actionCenter.workers')}</h3>
                          <p>{t('actionCenter.workersSubtitle')}</p>
                        </div>
                      </div>
                      {evidenceWorkers.length > 0 ? (
                        <ul className="space-y-1.5">
                          {evidenceWorkers.map((worker) => {
                            const evidence = workerEvidenceText(worker)
                            return (
                              <li key={worker.id}>
                                <button
                                  type="button"
                                  onClick={() => handleOpenWorker(worker.id)}
                                  className="action-center-list-row"
                                  data-tone={worker.status === 'working' ? 'green' : 'neutral'}
                                  disabled={!onOpenWorker}
                                  data-testid={`action-center-worker-${worker.id}`}
                                >
                                  <span className="action-center-worker-avatar" aria-hidden>
                                    <UserRound size={13} />
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="flex min-w-0 items-center gap-2">
                                      <span className="truncate text-xs font-medium text-pri">
                                        {worker.name}
                                      </span>
                                      <span className="shrink-0 text-[11px] text-ter">
                                        {workerEvidenceLabel(worker, t)}
                                      </span>
                                    </span>
                                    {evidence ? (
                                      <span className="block truncate text-[11px] text-ter">
                                        {evidence}
                                      </span>
                                    ) : null}
                                  </span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      ) : (
                        <div className="action-center-empty">
                          {t('actionCenter.noWorkerEvidence')}
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              )}
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export const ActionCenterTopbarButton = ({ onOpenWorker, workspaceId }: ActionCenterProps) => {
  const { t } = useI18n()
  const { error, summary } = useActionCenterSummary(workspaceId)
  const { copyingRecap, handleCopyRecap } = useRecapCopy(workspaceId)
  const [open, setOpen] = useState(false)

  return (
    <>
      <Tooltip label={open ? t('actionCenter.collapse') : t('actionCenter.expand')}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={open ? t('actionCenter.collapse') : t('actionCenter.expand')}
          data-testid="topbar-action-center"
          className="flex h-7 cursor-pointer items-center gap-1 rounded border px-2 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
        >
          <Activity size={13} aria-hidden />
          <span>{t('actionCenter.title')}</span>
          {summary && summary.summary.workingWorkers > 0 ? (
            <span className="mono rounded bg-3 px-1 text-[11px] text-accent">
              {summary.summary.workingWorkers}
            </span>
          ) : null}
        </button>
      </Tooltip>
      <ActionCenterDrawer
        key={workspaceId}
        copyingRecap={copyingRecap}
        error={error}
        onClose={() => setOpen(false)}
        onCopyRecap={handleCopyRecap}
        {...(onOpenWorker ? { onOpenWorker } : {})}
        open={open}
        summary={summary}
      />
    </>
  )
}

export const ActionCenterStrip = ({ onOpenWorker, workspaceId }: ActionCenterProps) => {
  const { t } = useI18n()
  const { error, summary } = useActionCenterSummary(workspaceId)
  const { copyingRecap, handleCopyRecap } = useRecapCopy(workspaceId)
  const [expanded, setExpanded] = useState(false)
  const { latest, latestDetail } = getActionCenterView(summary)

  return (
    <section
      className="shrink-0 border-b px-4 py-2"
      data-testid="action-center-strip"
      style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? t('actionCenter.collapse') : t('actionCenter.expand')}
          className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-semibold uppercase tracking-wide text-ter hover:bg-3 hover:text-pri"
        >
          {expanded ? (
            <ChevronDown size={13} aria-hidden />
          ) : (
            <ChevronRight size={13} aria-hidden />
          )}
          <Activity size={13} aria-hidden />
          {t('actionCenter.title')}
        </button>
        <span className="pill pill--green">
          {t('actionCenter.runningCount', { count: summary?.summary.workingWorkers ?? 0 })}
        </span>
        <span className="pill pill--ghost">
          {t('actionCenter.reportCount', { count: summary?.summary.recentReports ?? 0 })}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-sec">
        {error ? (
          <span style={{ color: 'var(--text-error)' }}>{t('actionCenter.loadFailed')}</span>
        ) : latest ? (
          <>
            <span className="shrink-0 text-ter">{describeActivity(latest, t)}</span>
            {latestDetail ? (
              <span className="min-w-0 truncate text-ter" title={latestDetail}>
                · {latestDetail}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-ter">
            {summary ? t('actionCenter.noActivity') : t('actionCenter.loading')}
          </span>
        )}
      </div>
      {expanded && summary ? (
        <ActionCenterDetails
          key={workspaceId}
          copyingRecap={copyingRecap}
          onCopyRecap={handleCopyRecap}
          {...(onOpenWorker ? { onOpenWorker } : {})}
          summary={summary}
        />
      ) : null}
    </section>
  )
}
