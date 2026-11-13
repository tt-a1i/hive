import * as Dialog from '@radix-ui/react-dialog'
import {
  Activity,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Info,
  Loader2,
  Maximize2,
  MinusCircle,
  OctagonX,
  Pause,
  Play,
  SlidersHorizontal,
  Trash2,
  Workflow,
  X,
  XCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  deleteWorkflowSchedule,
  listWorkflowRunDispatches,
  listWorkflowRunLogs,
  stopWorkflowRun,
  updateWorkflowSchedule,
  type WorkflowDispatchSummary,
  type WorkflowRun,
  type WorkflowRunLogEntry,
  type WorkflowRunStatus,
  type WorkflowSchedule,
} from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useToast } from '../ui/useToast.js'
import { useWorkflowsPolling } from './useWorkflowsPolling.js'
import { WorkflowCliPolicyControl } from './WorkflowCliPolicyControl.js'

interface WorkflowsDrawerProps {
  open: boolean
  onClose: () => void
  workspaceId: string | null
}

export interface WorkflowsContentProps {
  workspaceId: string | null
  onClose?: () => void
}

const RUN_STATUS_ICON = (
  t: ReturnType<typeof useI18n>['t']
): Record<WorkflowRunStatus, React.ReactNode> => ({
  running: (
    <Loader2
      size={14}
      className="animate-spin text-accent"
      aria-label={t('workflows.status.running')}
    />
  ),
  completed: (
    <CheckCircle2
      size={14}
      className="text-status-green"
      aria-label={t('workflows.status.completed')}
    />
  ),
  failed: (
    <XCircle size={14} className="text-status-red" aria-label={t('workflows.status.failed')} />
  ),
  interrupted: (
    <MinusCircle
      size={14}
      className="text-status-orange"
      aria-label={t('workflows.status.interrupted')}
    />
  ),
  stopped: (
    <MinusCircle size={14} className="text-ter" aria-label={t('workflows.status.stopped')} />
  ),
})

const RUN_STATUS_TONE: Record<WorkflowRunStatus, string> = {
  running: 'drawer-status-badge--running',
  completed: 'drawer-status-badge--completed',
  failed: 'drawer-status-badge--failed',
  interrupted: 'drawer-status-badge--interrupted',
  stopped: 'drawer-status-badge--stopped',
}

const fileBasename = (path: string) => {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

const ageLabel = (ms: number, t: ReturnType<typeof useI18n>['t']): string => {
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 60) return t('common.time.sAgo', { count: seconds })
  if (seconds < 3600) return t('common.time.mAgo', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('common.time.hAgo', { count: Math.floor(seconds / 3600) })
  return t('common.time.dAgo', { count: Math.floor(seconds / 86400) })
}

const truncateText = (text: string | null, max = 80): string => {
  if (!text) return ''
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

const durationLabel = (startedAt: number, finishedAt: number | null): string => {
  const elapsed = (finishedAt ?? Date.now()) - startedAt
  if (elapsed < 1000) return `${elapsed}ms`
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return s === 0 ? `${m}m` : `${m}m${s}s`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m === 0 ? `${h}h` : `${h}h${m}m`
}

const argsLabel = (args: unknown): string | null => {
  if (args === null || args === undefined) return null
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return null
  }
}

const formatResultText = (result: unknown): string =>
  typeof result === 'string' ? result : JSON.stringify(result, null, 2)

/* TIER 2 #5 — group nested workflow runs under their parents. Returns
   a flat list of (run, depth) pairs in DFS order so the renderer can
   indent children without restructuring the JSX tree. We only nest one
   level deep (children of a run shown under it); deeper nesting just
   stays indented at depth=1 because deeper trees are rare and the
   visual cost of multi-level threading isn't worth the complexity. */
interface RunTreeEntry {
  run: WorkflowRun
  depth: number
}
const buildRunTree = (runs: WorkflowRun[]): RunTreeEntry[] => {
  const byParent = new Map<string, WorkflowRun[]>()
  const tops: WorkflowRun[] = []
  for (const run of runs) {
    if (run.parentRunId) {
      const bucket = byParent.get(run.parentRunId) ?? []
      bucket.push(run)
      byParent.set(run.parentRunId, bucket)
    } else {
      tops.push(run)
    }
  }
  const out: RunTreeEntry[] = []
  for (const parent of tops) {
    out.push({ run: parent, depth: 0 })
    const children = byParent.get(parent.id) ?? []
    for (const child of children) out.push({ run: child, depth: 1 })
  }
  // Orphan children whose parent isn't in the list (e.g. parent rolled
  // out of the top-20 window) — keep them rendered at depth=0 so they
  // aren't lost.
  const placed = new Set(out.map((e) => e.run.id))
  for (const run of runs) {
    if (!placed.has(run.id)) out.push({ run, depth: 0 })
  }
  return out
}

const DISPATCH_STATUS_ICON: Record<
  WorkflowDispatchSummary['status'],
  { mark: string; tone: string }
> = {
  queued: { mark: '○', tone: 'text-ter' },
  submitted: { mark: '◐', tone: 'text-accent' },
  reported: { mark: '●', tone: 'text-status-green' },
  cancelled: { mark: '⊘', tone: 'text-status-red' },
}

const dispatchStatusLabel = (
  status: WorkflowDispatchSummary['status'],
  t: ReturnType<typeof useI18n>['t']
): string => t(`workflows.dispatchStatus.${status}` as TranslationKey)

const DispatchAgentRow = ({ dispatch }: { dispatch: WorkflowDispatchSummary }) => {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  const status = DISPATCH_STATUS_ICON[dispatch.status]
  const labelText = dispatch.label ?? `step-${dispatch.stepIndex ?? '?'}`
  const reportSnippet = dispatch.reportText ? truncateText(dispatch.reportText, 80) : null
  // TIER 2 #6 — last PTY line. Only present on submitted dispatches; gives
  // the user a live window into what each worker is currently doing.
  const ptyTail =
    dispatch.status === 'submitted' && dispatch.lastPtyLine
      ? truncateText(dispatch.lastPtyLine, 80)
      : null
  const pending =
    dispatch.status === 'submitted'
      ? ptyTail
        ? null
        : t('workflows.dispatchStatus.awaitingReport')
      : dispatch.status === 'cancelled'
        ? t('workflows.dispatchStatus.cancelled')
        : dispatch.status === 'queued'
          ? t('workflows.dispatchStatus.queued')
          : null

  return (
    <div
      className="wf-dispatch-item rounded-md text-xs"
      data-testid={`workflow-dispatch-row-${dispatch.id}`}
      data-dispatch-status={dispatch.status}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="wf-dispatch-header"
        aria-expanded={open}
      >
        <span className={`wf-dispatch-mark ${status.tone}`} aria-hidden>
          {status.mark}
        </span>
        <span className="wf-dispatch-step" title={`step ${dispatch.stepIndex ?? '?'}`}>
          #{dispatch.stepIndex ?? '?'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="wf-dispatch-title">{labelText}</span>
          <span className={`wf-dispatch-status wf-dispatch-status--${dispatch.status}`}>
            {dispatchStatusLabel(dispatch.status, t)}
          </span>
          {reportSnippet ? (
            <span className="wf-dispatch-summary">↳ {reportSnippet}</span>
          ) : ptyTail ? (
            <span
              className="wf-dispatch-summary"
              title={dispatch.lastPtyLine}
              data-testid={`workflow-dispatch-pty-${dispatch.id}`}
            >
              <span className="text-accent">⟶</span>
              <span className="font-mono">{ptyTail}</span>
            </span>
          ) : pending ? (
            <span className="wf-dispatch-summary italic">{pending}</span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="wf-dispatch-detail" data-testid={`workflow-dispatch-detail-${dispatch.id}`}>
          {dispatch.text ? (
            <div>
              <div className="wf-dispatch-detail__label">prompt</div>
              <div className="whitespace-pre-wrap text-pri">{dispatch.text}</div>
            </div>
          ) : null}
          {dispatch.reportText ? (
            <div>
              <div className="wf-dispatch-detail__label">report</div>
              <div className="whitespace-pre-wrap text-pri">{dispatch.reportText}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

interface PhaseGroup {
  title: string
  dispatches: WorkflowDispatchSummary[]
}

// Group dispatches by phase in their order of appearance. Dispatches with no
// phase (legacy or non-phase'd runs) fall under a "—" implicit group.
const groupDispatchesByPhase = (dispatches: WorkflowDispatchSummary[]): PhaseGroup[] => {
  const groups: PhaseGroup[] = []
  const byTitle = new Map<string, PhaseGroup>()
  for (const d of dispatches) {
    const title = d.phase ?? '—'
    let group = byTitle.get(title)
    if (!group) {
      group = { title, dispatches: [] }
      byTitle.set(title, group)
      groups.push(group)
    }
    group.dispatches.push(d)
  }
  return groups
}

const PhaseStrip = ({
  group,
  runStatus,
  defaultOpen,
}: {
  group: PhaseGroup
  runStatus: WorkflowRunStatus
  defaultOpen: boolean
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const completed = group.dispatches.filter(
    (d) => d.status === 'reported' || d.status === 'cancelled'
  ).length
  const total = group.dispatches.length
  const allDone = completed === total
  const someRunning = !allDone && runStatus === 'running'
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  return (
    <div className="wf-phase-strip" data-testid={`workflow-phase-${group.title}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="wf-phase-strip__toggle pointer-coarse:min-h-10"
        aria-expanded={open}
      >
        <span className="wf-phase-strip__chevron">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-sec">
          {group.title === '—' ? '(no phase)' : group.title}
        </span>
        <span
          className={`wf-phase-strip__badge ${
            allDone
              ? 'wf-phase-strip__badge--done'
              : someRunning
                ? 'wf-phase-strip__badge--running'
                : ''
          }`}
        >
          {completed}/{total}
          {someRunning ? ' ⟳' : allDone ? ' ✓' : ''}
        </span>
      </button>
      {/* thin progress bar under the phase header */}
      <div className="wf-phase-strip__bar">
        <span
          style={{ width: `${pct}%` }}
          className={
            allDone
              ? 'wf-phase-strip__bar-fill--done'
              : someRunning
                ? 'wf-phase-strip__bar-fill--running'
                : 'wf-phase-strip__bar-fill'
          }
        />
      </div>
      {open ? (
        <div className="wf-phase-body" data-testid={`workflow-phase-body-${group.title}`}>
          {group.dispatches.map((d) => (
            <DispatchAgentRow key={d.id} dispatch={d} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// TIER 1 #12 — Result panel with Copy / Expand-to-modal. The old code was a
// plain <pre> inside a 560px drawer, which is unreadable for the
// markdown-heavy results most review/audit workflows return.
const ResultPanel = ({ runId, result }: { runId: string; result: unknown }) => {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = formatResultText(result)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard API may be unavailable in non-secure contexts; UI degrades gracefully */
    }
  }
  return (
    <div className="wf-result mb-2" data-testid={`workflow-run-result-${runId}`}>
      <div className="wf-result__header">
        <div className="wf-result__label">Result</div>
        <div className="flex items-center gap-1">
          <Tooltip label={copied ? 'Copied!' : 'Copy result'}>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy result"
              className="icon-btn pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              data-testid={`workflow-run-result-copy-${runId}`}
            >
              {copied ? <Check size={11} className="text-status-green" /> : <Copy size={11} />}
            </button>
          </Tooltip>
          <Tooltip label="Expand">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Expand result"
              className="icon-btn pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              data-testid={`workflow-run-result-expand-${runId}`}
            >
              <Maximize2 size={11} />
            </button>
          </Tooltip>
        </div>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-pri">{text}</pre>
      {expanded ? (
        <Dialog.Root open={expanded} onOpenChange={(o) => setExpanded(o)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
            <Dialog.Content
              className="fixed inset-4 z-50 flex flex-col rounded-lg border bg-[var(--bg-1)] p-4 shadow-xl md:inset-8 lg:inset-16"
              style={{ borderColor: 'var(--border-bright)' }}
              data-testid={`workflow-run-result-modal-${runId}`}
            >
              <div className="mb-2 flex items-center justify-between">
                <Dialog.Title className="text-sm font-semibold">Workflow result</Dialog.Title>
                <div className="flex items-center gap-1">
                  <Tooltip label={copied ? 'Copied!' : 'Copy'}>
                    <button
                      type="button"
                      onClick={copy}
                      aria-label="Copy"
                      className="icon-btn pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    >
                      {copied ? (
                        <Check size={14} className="text-status-green" />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                  </Tooltip>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close"
                      className="icon-btn pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    >
                      <X size={14} />
                    </button>
                  </Dialog.Close>
                </div>
              </div>
              <textarea
                readOnly
                value={text}
                className="min-h-0 flex-1 resize-none rounded border bg-[var(--bg-0)] p-2 font-mono text-xs"
                style={{ borderColor: 'var(--border)' }}
              />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </div>
  )
}

const RunRow = ({ run, onStop }: { run: WorkflowRun; onStop: () => Promise<void> }) => {
  const [expanded, setExpanded] = useState(false)
  const [dispatches, setDispatches] = useState<WorkflowDispatchSummary[] | null>(null)
  const [logs, setLogs] = useState<WorkflowRunLogEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const { t } = useI18n()

  // TIER 1 #14 — metadata sub-row content. Built once per render so we
  // don't recompute on the typescript hot path inside JSX.
  const metaItems: Array<{ key: string; text: string }> = []
  if (run.phase) metaItems.push({ key: 'phase', text: `phase: ${run.phase}` })
  if (run.agentCount > 0)
    metaItems.push({
      key: 'agentCount',
      text: `${run.agentCount} agent${run.agentCount === 1 ? '' : 's'}`,
    })
  if (run.status !== 'running')
    metaItems.push({ key: 'duration', text: durationLabel(run.startedAt, run.finishedAt) })
  const argsFull = argsLabel(run.args)
  const argsShort = argsFull ? truncateText(argsFull, 60) : null

  // biome-ignore lint/correctness/useExhaustiveDependencies: run.status is intentional — refetch on the running→completed flip so the timeline catches the final dispatches.
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    setLoading(true)
    setError(null)
    // TIER 2 #3 — narrator lane fetched in parallel with dispatches so a
    // run that's mostly `log()`-noisy (e.g. a recon workflow) doesn't
    // show empty when expanded just because it has no agent() calls.
    Promise.all([listWorkflowRunDispatches(run.id), listWorkflowRunLogs(run.id)])
      .then(([dispatchList, logList]) => {
        if (cancelled) return
        setDispatches(dispatchList)
        setLogs(logList)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [expanded, run.id, run.status])

  return (
    <div
      className="drawer-card text-xs"
      data-testid={`workflow-run-row-${run.id}`}
      data-run-status={run.status}
    >
      <div className="wf-run-summary-row">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="wf-run-toggle"
          aria-expanded={expanded}
          data-testid={`workflow-run-toggle-${run.id}`}
        >
          <span className="wf-run-toggle__chevron">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
          <span className="wf-run-toggle__icon">{RUN_STATUS_ICON(t)[run.status]}</span>
          <span className="wf-run-toggle__main">
            <span className="wf-run-toggle__name">{run.name}</span>
            <span className="wf-run-toggle__meta">
              <span className={`drawer-status-badge ${RUN_STATUS_TONE[run.status]}`}>
                {t(`workflows.status.${run.status}`)}
              </span>
              {run.status === 'running'
                ? ageLabel(run.startedAt, t)
                : ageLabel(run.finishedAt ?? run.startedAt, t)}
            </span>
          </span>
        </button>
        {run.status === 'running' ? (
          <div className="drawer-card__actions pr-1 wf-run-stop-area">
            <Tooltip label={t('workflows.stopTooltip')}>
              <button
                type="button"
                onClick={async () => {
                  setStopping(true)
                  try {
                    await onStop()
                  } finally {
                    setStopping(false)
                  }
                }}
                disabled={stopping}
                aria-label={t('workflows.stopTooltip')}
                className="wf-run-stop-btn icon-btn icon-btn--danger mr-1 disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                data-testid={`workflow-run-stop-${run.id}`}
              >
                <OctagonX size={12} />
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
      {metaItems.length > 0 || argsShort ? (
        <div className="wf-run-meta" data-testid={`workflow-run-meta-${run.id}`}>
          {metaItems.length > 0
            ? metaItems.map((item) => (
                <span key={item.key} className="wf-run-meta__item">
                  {item.text}
                </span>
              ))
            : null}
          {argsShort ? (
            <span className="wf-run-meta__item wf-run-meta__args" title={argsFull ?? undefined}>
              args: {argsShort}
            </span>
          ) : null}
        </div>
      ) : null}
      {expanded ? (
        <div className="wf-run-detail" data-testid={`workflow-run-detail-${run.id}`}>
          {run.result !== null && run.result !== undefined ? (
            <ResultPanel runId={run.id} result={run.result} />
          ) : null}
          {error ? (
            <div className="text-error">{error}</div>
          ) : loading && dispatches === null ? (
            <div className="text-ter">{t('workflows.loading')}</div>
          ) : dispatches && dispatches.length > 0 ? (
            (() => {
              const groups = groupDispatchesByPhase(dispatches)
              // Default-open the *last* phase (the one most likely currently
              // active), collapse earlier completed ones to keep the strip
              // scannable. Single-phase runs always open.
              const lastIndex = groups.length - 1
              return (
                <div className="space-y-1.5">
                  {groups.map((g, idx) => (
                    <PhaseStrip
                      key={g.title}
                      group={g}
                      runStatus={run.status}
                      defaultOpen={groups.length === 1 || idx === lastIndex}
                    />
                  ))}
                </div>
              )
            })()
          ) : (
            <div className="text-ter italic">{t('workflows.noAgents')}</div>
          )}
          {/* TIER 2 #3 — narrator lane. Renders below the phase tree so
              dispatches stay primary; `log()`-heavy workflows still get
              their lines surfaced. Hidden when empty so the panel doesn't
              show a stub for runs that didn't call log(). */}
          {logs && logs.length > 0 ? (
            <div className="wf-logs-panel" data-testid={`workflow-run-logs-${run.id}`}>
              <div className="wf-logs-panel__title">
                {logs.length === 1
                  ? t('workflows.narratorOne')
                  : t('workflows.narrator', { count: logs.length })}
              </div>
              <ul className="space-y-0.5 font-mono text-[11px]">
                {logs.map((entry) => (
                  <li key={entry.id} className="text-sec">
                    {entry.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.error ? (
            <div className="text-error">{t('workflows.runError', { error: run.error })}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// Schedules are CREATED by the orchestrator (`team workflow schedule`); the UI
// only pauses / resumes / deletes them.
const ScheduleRow = ({
  schedule,
  onToggle,
  onDelete,
}: {
  schedule: WorkflowSchedule
  onToggle: (next: boolean) => void | Promise<void>
  onDelete: () => void | Promise<void>
}) => {
  const { t } = useI18n()
  return (
    <div
      className="drawer-card wf-schedule-row flex items-center gap-3"
      data-testid={`workflow-schedule-row-${schedule.id}`}
      data-schedule-enabled={schedule.enabled ? 'true' : 'false'}
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        style={{
          background: schedule.enabled
            ? 'color-mix(in oklab, var(--accent) 12%, transparent)'
            : 'var(--bg-3)',
          color: schedule.enabled ? 'var(--accent)' : 'var(--text-tertiary)',
        }}
      >
        <CalendarClock size={13} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-pri">
          {fileBasename(schedule.scriptPath)}
        </div>
        <div className="truncate font-mono text-[10.5px] text-ter mt-0.5">{schedule.cron}</div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip
          label={schedule.enabled ? t('workflows.pauseTooltip') : t('workflows.resumeTooltip')}
        >
          <button
            type="button"
            onClick={() => void onToggle(!schedule.enabled)}
            aria-label={
              schedule.enabled ? t('workflows.pauseTooltip') : t('workflows.resumeTooltip')
            }
            className="icon-btn pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            data-testid={`workflow-schedule-toggle-${schedule.id}`}
          >
            {schedule.enabled ? <Pause size={12} /> : <Play size={12} />}
          </button>
        </Tooltip>
        <Tooltip label={t('workflows.deleteScheduleTooltip')}>
          <button
            type="button"
            onClick={() => void onDelete()}
            aria-label={t('workflows.deleteScheduleTooltip')}
            className="icon-btn icon-btn--danger pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            data-testid={`workflow-schedule-delete-${schedule.id}`}
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

export const WorkflowsContent = ({ workspaceId, onClose }: WorkflowsContentProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const { runs, schedules, error, refresh, refreshSchedules } = useWorkflowsPolling({
    workspaceId,
    enabled: true,
  })
  const [runFilter, setRunFilter] = useState<'all' | 'running' | 'failed'>('all')
  const runningCount = runs.filter((r) => r.status === 'running').length
  const failedCount = runs.filter(
    (r) => r.status === 'failed' || r.status === 'stopped' || r.status === 'interrupted'
  ).length

  const handleToggleSchedule = async (id: string, enabled: boolean) => {
    try {
      await updateWorkflowSchedule(id, { enabled })
    } catch (err) {
      toast.show({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      await refreshSchedules()
    }
  }

  const handleDeleteSchedule = async (id: string) => {
    try {
      await deleteWorkflowSchedule(id)
    } catch (err) {
      toast.show({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      await refreshSchedules()
    }
  }

  return (
    <div className="workflows-content flex h-full min-h-0 flex-col" data-testid="workflows-content">
      <header
        className="wf-panel-header border-b px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="wf-panel-header__main">
          <div
            className="wf-panel-header__icon"
            style={{
              background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
              color: 'var(--accent)',
            }}
          >
            <Workflow size={15} aria-hidden />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="text-[13px] font-semibold text-pri leading-tight">
              {t('workflows.title')}
            </span>
            <div className="relative group inline-block cursor-help shrink-0">
              <Info size={12} className="text-ter hover:text-sec transition-colors" />
              <div className="absolute hidden group-hover:block left-0 top-full mt-1.5 w-72 p-3 bg-[var(--bg-2)] border border-border rounded-xl shadow-2xl text-[11px] text-sec leading-relaxed z-50 pointer-events-none">
                {t('workflows.description')}
              </div>
            </div>
            <span className="wf-panel-count" data-testid="workflows-summary-count">
              {runs.length}
            </span>
          </div>
        </div>
        {onClose ? (
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
        ) : null}
      </header>

      <div className="scroll-y flex-1 px-4 py-3">
        {error ? (
          <div
            className="mb-3 rounded-md border px-3 py-2 text-xs"
            style={{
              borderColor: 'color-mix(in oklab, var(--status-red) 30%, var(--border))',
              color: 'var(--text-error)',
              background: 'color-mix(in oklab, var(--status-red) 8%, transparent)',
            }}
            data-testid="workflows-error"
          >
            {error}
          </div>
        ) : null}

        <div className="flex flex-col md:flex-row gap-5 items-start">
          {/* Left Column: Recent Runs & Schedules */}
          <div className="flex-1 min-w-0 w-full space-y-4">
            <section className="wf-content-section mb-0">
              <div className="drawer-section__header mb-2">
                <div className="wf-section-title">
                  <Activity size={14} aria-hidden className="text-sec" />
                  <div>
                    <h3 className="drawer-section-label wf-section-label-tight">
                      {t('workflows.recentRuns')}
                    </h3>
                    <p className="wf-section-subtitle">
                      {runningCount > 0
                        ? `${runningCount} ${t('workflows.filterRunning')}`
                        : t('workflows.emptyRunsDesc')}
                    </p>
                  </div>
                </div>
                {runs.length > 0
                  ? (() => {
                      const Pill = ({
                        id,
                        label,
                        count,
                      }: {
                        id: 'all' | 'running' | 'failed'
                        label: string
                        count: number
                      }) => (
                        <button
                          type="button"
                          onClick={() => setRunFilter(id)}
                          aria-pressed={runFilter === id}
                          data-testid={`workflow-runs-filter-${id}`}
                          className={`wf-run-filter-pill pointer-coarse:min-h-9 pointer-coarse:text-xs ${
                            runFilter === id ? 'wf-run-filter-pill--active' : ''
                          }`}
                        >
                          {id === 'all' ? (
                            <Workflow size={11} aria-hidden />
                          ) : id === 'running' ? (
                            <Loader2 size={11} aria-hidden className="animate-spin" />
                          ) : (
                            <XCircle size={11} aria-hidden />
                          )}
                          <span>{label}</span>
                          <span className="wf-run-filter-pill__count">{count}</span>
                        </button>
                      )
                      return (
                        <div className="wf-run-filters">
                          <Pill id="all" label={t('workflows.filterAll')} count={runs.length} />
                          <Pill
                            id="running"
                            label={t('workflows.filterRunning')}
                            count={runningCount}
                          />
                          <Pill
                            id="failed"
                            label={t('workflows.filterFailed')}
                            count={failedCount}
                          />
                        </div>
                      )
                    })()
                  : null}
              </div>
              {runs.length === 0 ? (
                <div className="wf-empty-surface">
                  <EmptyState
                    icon={<Workflow size={18} />}
                    title={t('workflows.emptyRuns')}
                    description={t('workflows.emptyRunsDesc')}
                  />
                </div>
              ) : (
                (() => {
                  const filteredRuns =
                    runFilter === 'all'
                      ? runs
                      : runFilter === 'running'
                        ? runs.filter((r) => r.status === 'running')
                        : runs.filter(
                            (r) =>
                              r.status === 'failed' ||
                              r.status === 'stopped' ||
                              r.status === 'interrupted'
                          )
                  if (filteredRuns.length === 0) {
                    return (
                      <div className="wf-empty-inline" data-testid="workflow-runs-empty-filter">
                        {t('workflows.emptyFilter')}
                      </div>
                    )
                  }
                  return (
                    <ul className="space-y-2">
                      {buildRunTree(filteredRuns.slice(0, 20)).map(({ run, depth }) => (
                        <li
                          key={run.id}
                          className={`wf-run-tree-item ${depth > 0 ? 'wf-run-tree-item--child' : ''}`}
                          data-testid={`workflow-run-tree-${run.id}`}
                          data-depth={depth}
                        >
                          {depth > 0 ? (
                            <>
                              <span className="wf-tree-connector" aria-hidden="true" />
                              <div className="wf-run-tree-item__content">
                                <RunRow
                                  run={run}
                                  onStop={async () => {
                                    try {
                                      await stopWorkflowRun(run.id)
                                    } catch (err) {
                                      toast.show({
                                        kind: 'error',
                                        message: err instanceof Error ? err.message : String(err),
                                      })
                                    } finally {
                                      await refresh()
                                    }
                                  }}
                                />
                              </div>
                            </>
                          ) : (
                            <div className="wf-run-tree-item__content">
                              <RunRow
                                run={run}
                                onStop={async () => {
                                  try {
                                    await stopWorkflowRun(run.id)
                                  } catch (err) {
                                    toast.show({
                                      kind: 'error',
                                      message: err instanceof Error ? err.message : String(err),
                                    })
                                  } finally {
                                    await refresh()
                                  }
                                }}
                              />
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )
                })()
              )}
            </section>

            {schedules.length > 0 ? (
              <section
                className="wf-content-section mb-0"
                data-testid="workflows-schedules-section"
              >
                <div className="drawer-section__header mb-2">
                  <div className="wf-section-title">
                    <CalendarClock size={14} aria-hidden className="text-sec" />
                    <div>
                      <h3 className="drawer-section-label wf-section-label-tight">
                        {t('workflows.schedules')}
                      </h3>
                      <p className="wf-section-subtitle">
                        {schedules.length} {t('workflows.schedules')}
                      </p>
                    </div>
                  </div>
                </div>
                <ul className="space-y-1.5">
                  {schedules.map((sch) => (
                    <li key={sch.id}>
                      <ScheduleRow
                        schedule={sch}
                        onToggle={(next) => handleToggleSchedule(sch.id, next)}
                        onDelete={() => handleDeleteSchedule(sch.id)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          {/* Right Column: CLI Policy settings */}
          <div className="w-full md:w-[280px] shrink-0 wf-sidebar-settings">
            <section className="drawer-section">
              <div className="drawer-section__header mb-2">
                <div className="wf-section-title">
                  <SlidersHorizontal size={14} aria-hidden className="text-sec" />
                  <h3 className="drawer-section-label wf-section-label-tight">
                    {t('workflows.cli.title')}
                  </h3>
                </div>
              </div>
              <WorkflowCliPolicyControl />
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

export const WorkflowsDrawer = ({ open, onClose, workspaceId }: WorkflowsDrawerProps) => {
  const isMobile = useIsMobile()
  const { t } = useI18n()

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="workflows-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="workflows-drawer"
            aria-label={t('workflows.title')}
            data-mobile={isMobile || undefined}
            className="dialog-scale-pop elev-2 pointer-events-auto flex flex-col rounded-lg border"
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
            <Dialog.Title className="sr-only">{t('workflows.title')}</Dialog.Title>
            <WorkflowsContent workspaceId={workspaceId} onClose={onClose} />
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
