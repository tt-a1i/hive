import { useEffect, useRef, useState } from 'react'
import { type ActionCenterDispatchDetail, getActionCenterDispatch } from '../api.js'
import { useI18n } from '../i18n.js'
import { ActionCenterArtifact } from './ActionCenterArtifact.js'

export const ActionCenterReport = ({
  workspaceId,
  dispatchId,
  onClose,
  onOpenWorker,
  onOpenHistory,
}: {
  workspaceId: string
  dispatchId: string
  onClose: () => void
  onOpenWorker?: (workerId: string) => void
  onOpenHistory?: (dispatchId: string) => void
}) => {
  const { t } = useI18n()
  const heading = useRef<HTMLHeadingElement>(null)
  const [report, setReport] = useState<ActionCenterDispatchDetail | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry explicitly starts a fresh read.
  useEffect(() => {
    const controller = new AbortController()
    setReport(null)
    setError(false)
    heading.current?.focus()
    void getActionCenterDispatch(workspaceId, dispatchId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setReport(detail)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [workspaceId, dispatchId, attempt])

  const artifactPaths = new Set<string>()
  const artifacts = (report?.artifacts ?? []).flatMap((path, index) => {
    if (artifactPaths.has(path)) return []
    artifactPaths.add(path)
    return [{ path, index }]
  })

  return (
    <section className="action-center-panel min-w-0" data-testid="action-center-report-detail">
      <div className="action-center-panel__header">
        <h3 ref={heading} tabIndex={-1}>
          {t('actionCenter.report.title')} · {dispatchId.slice(0, 8)}
        </h3>
        <button type="button" className="text-xs text-accent" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
      <p className="mb-2 text-xs text-ter">{t('actionCenter.report.evidence')}</p>
      {error ? (
        <p role="alert" className="text-xs text-sec">
          {t('actionCenter.loadFailed')}{' '}
          <button
            type="button"
            className="text-accent"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t('common.retry')}
          </button>
        </p>
      ) : report?.workspace_id === workspaceId && report.id === dispatchId ? (
        <>
          <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-pri">
            {report.report_text ?? t('actionCenter.report.noReport')}
          </p>
          {onOpenHistory ? (
            <button
              type="button"
              className="mt-3 block text-xs text-accent"
              onClick={() => onOpenHistory(report.id)}
            >
              {t('actionCenter.report.openHistory')}
            </button>
          ) : null}
          {report.artifacts.length > 0 ? (
            <div className="mt-3 text-xs text-sec">
              <h4 className="font-medium">{t('actionCenter.report.artifacts')}</h4>
              <ul className="mt-1 space-y-1">
                {artifacts.map(({ path, index }) => (
                  <ActionCenterArtifact
                    key={`${workspaceId}:${dispatchId}:${path}`}
                    workspaceId={workspaceId}
                    dispatchId={dispatchId}
                    artifactIndex={index}
                    path={path}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          {onOpenWorker ? (
            <button
              type="button"
              className="mt-3 text-xs text-accent"
              onClick={() => onOpenWorker(report.to_agent_id)}
            >
              {t('actionCenter.report.openTerminal')}
            </button>
          ) : null}
        </>
      ) : (
        <p role="status" className="text-xs text-ter">
          {t('actionCenter.loading')}
        </p>
      )}
    </section>
  )
}
