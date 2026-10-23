import { useEffect, useId, useRef, useState } from 'react'
import { type ActionCenterArtifactContent, getActionCenterArtifact } from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'

const errorKeys: Record<number, TranslationKey> = {
  400: 'actionCenter.artifact.invalid',
  401: 'actionCenter.artifact.auth',
  403: 'actionCenter.artifact.forbidden',
  404: 'actionCenter.artifact.missing',
  409: 'actionCenter.artifact.changed',
  413: 'actionCenter.artifact.large',
  415: 'actionCenter.artifact.unsupported',
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'loaded'; data: ActionCenterArtifactContent }
  | { kind: 'error'; key: TranslationKey }

export const ActionCenterArtifact = ({
  workspaceId,
  dispatchId,
  artifactIndex,
  path,
}: {
  workspaceId: string
  dispatchId: string
  artifactIndex: number
  path: string
}) => {
  const { t, language } = useI18n()
  const previewId = useId()
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<PreviewState>({ kind: 'loading' })
  const request = useRef<AbortController | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reads the current file again.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    request.current = controller
    setState({ kind: 'loading' })
    void getActionCenterArtifact(workspaceId, dispatchId, artifactIndex, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setState(
          result.ok
            ? { kind: 'loaded', data: result.data }
            : { kind: 'error', key: errorKeys[result.status] ?? 'actionCenter.artifact.failed' }
        )
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ kind: 'error', key: 'actionCenter.artifact.failed' })
        }
      })
    return () => controller.abort()
  }, [open, workspaceId, dispatchId, artifactIndex, attempt])

  const refresh = () => {
    request.current?.abort()
    setState({ kind: 'loading' })
    setAttempt((value) => value + 1)
  }

  return (
    <li className="min-w-0">
      <p className="select-text break-all font-mono">{path}</p>
      <button
        type="button"
        className="mt-1 text-accent"
        aria-label={`${t(open ? 'actionCenter.artifact.close' : 'actionCenter.artifact.view')}: ${path}`}
        aria-expanded={open}
        aria-controls={previewId}
        onClick={() => {
          request.current?.abort()
          setState({ kind: 'loading' })
          setOpen((value) => !value)
        }}
      >
        {t(open ? 'actionCenter.artifact.close' : 'actionCenter.artifact.view')}
      </button>
      <div
        id={previewId}
        hidden={!open}
        className="mt-2 min-w-0 rounded border border-border-bright p-2"
      >
        {open ? (
          <>
            <p className="mb-2 text-ter">{t('actionCenter.artifact.current')}</p>
            {state.kind === 'loading' ? (
              <p role="status">{t('actionCenter.loading')}</p>
            ) : state.kind === 'error' ? (
              <p role="alert">
                {t(state.key)}{' '}
                <button type="button" className="text-accent" onClick={refresh}>
                  {t('common.retry')}
                </button>
              </p>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-ter">
                  <span>
                    {t('actionCenter.artifact.metadata', {
                      size: state.data.size_bytes,
                      date: new Date(state.data.modified_at).toLocaleString(language),
                    })}
                  </span>
                  <button type="button" className="text-accent" onClick={refresh}>
                    {t('actionCenter.artifact.refresh')}
                  </button>
                </div>
                {state.data.content === '' ? (
                  <p role="status">{t('actionCenter.artifact.empty')}</p>
                ) : (
                  <section
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded preview must support keyboard scrolling.
                    tabIndex={0}
                    aria-label={path}
                    className="max-h-80 min-w-0 select-text overflow-auto whitespace-pre-wrap text-pri"
                    style={{ overflowWrap: 'anywhere' }}
                  >
                    <pre className="whitespace-pre-wrap">{state.data.content}</pre>
                  </section>
                )}
              </>
            )}
          </>
        ) : null}
      </div>
    </li>
  )
}
