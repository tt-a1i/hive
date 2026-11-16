import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { getWorkflowCliPolicy, saveWorkflowCliPolicy } from '../api.js'
import { useI18n } from '../i18n.js'

const CLI_LABELS: Record<string, string> = {
  agy: 'Antigravity CLI',
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor CLI',
  gemini: 'Gemini',
  grok: 'Grok Build',
  hermes: 'Hermes',
  kimi: 'Kimi Code',
  opencode: 'OpenCode',
  pi: 'Pi',
  qwen: 'Qwen Code',
}

const CLI_ICONS: Record<string, string> = {
  agy: '/cli-icons/agy.png',
  claude: '/cli-icons/claude.png',
  codex: '/cli-icons/codex.png',
  cursor: '/cli-icons/cursor.ico',
  gemini: '/cli-icons/gemini.png',
  grok: '/cli-icons/grok.ico',
  hermes: '/cli-icons/hermes.png',
  kimi: '/cli-icons/kimi.png',
  opencode: '/cli-icons/opencode.svg',
  pi: '/cli-icons/pi.svg',
  qwen: '/cli-icons/qwen.png',
}

const CliIcon = ({ cli }: { cli: string }) => {
  const icon = CLI_ICONS[cli]
  return icon ? (
    <img src={icon} alt="" aria-hidden className="wf-cli-option__icon" />
  ) : (
    <TerminalSquare size={13} aria-hidden className="wf-cli-option__fallback-icon" />
  )
}

const toOffered = (supported: string[]): Array<{ cli: string; label: string }> =>
  supported.map((cli) => ({ cli, label: CLI_LABELS[cli] ?? cli }))

/**
 * Lets the user choose which CLI a workflow's `agent()` launches when the
 * script doesn't name one, and constrain which CLIs are allowed at all. Writes
 * the global workflow CLI policy via /api/settings/workflow-cli-policy.
 */
export const WorkflowCliPolicyControl = () => {
  const { t } = useI18n()
  const [offered, setOffered] = useState<Array<{ cli: string; label: string }>>([])
  const [allowed, setAllowed] = useState<string[]>([])
  const [defaultCli, setDefaultCli] = useState<string>('claude')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'saved' | 'error' | null>(null)
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    let cancelled = false
    void getWorkflowCliPolicy()
      .then((policy) => {
        if (cancelled) return
        const nextOffered = toOffered(policy.supported)
        const nextOfferedIds = nextOffered.map((o) => o.cli)
        const offeredAllowed = nextOfferedIds.filter((cli) => policy.allowed.includes(cli))
        setOffered(nextOffered)
        setAllowed(offeredAllowed.length > 0 ? offeredAllowed : nextOfferedIds)
        setDefaultCli(
          nextOfferedIds.includes(policy.default) ? policy.default : (nextOfferedIds[0] ?? 'claude')
        )
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [])

  const toggleAllowed = (cli: string) => {
    setStatus(null)
    setAllowed((prev) => {
      const next = prev.includes(cli) ? prev.filter((c) => c !== cli) : [...prev, cli]
      // Keep the default valid: if it just left the allowlist, move it to the
      // first remaining allowed CLI.
      if (!next.includes(defaultCli) && next.length > 0) setDefaultCli(next[0] as string)
      return next
    })
  }

  const pickDefault = (cli: string) => {
    setStatus(null)
    setDefaultCli(cli)
    if (!allowed.includes(cli)) setAllowed((prev) => [...prev, cli])
  }

  const canSave = !saving && allowed.length > 0 && allowed.includes(defaultCli)
  const defaultLabel = offered.find((item) => item.cli === defaultCli)?.label ?? defaultCli

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setStatus(null)
    try {
      const saved = await saveWorkflowCliPolicy({ default: defaultCli, allowed })
      const nextOffered = toOffered(saved.supported)
      const nextOfferedIds = nextOffered.map((o) => o.cli)
      const offeredAllowed = nextOfferedIds.filter((cli) => saved.allowed.includes(cli))
      setOffered(nextOffered)
      setAllowed(offeredAllowed)
      setDefaultCli(
        nextOfferedIds.includes(saved.default) ? saved.default : (nextOfferedIds[0] ?? 'claude')
      )
      setStatus('saved')
    } catch {
      setStatus('error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="wf-cli-policy" data-testid="workflow-cli-policy">
      <button
        type="button"
        className="wf-cli-policy__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="wf-cli-policy__hero">
          <div className="wf-cli-policy__hero-icon">
            <TerminalSquare size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="wf-cli-policy__title">{t('workflows.cli.title')}</div>
            <p className="wf-cli-policy__desc">{t('workflows.cli.desc')}</p>
          </div>
        </div>
        <div className="wf-cli-policy__summary">
          <div className="wf-cli-policy__summary-card">
            <span className="wf-cli-policy__summary-label">{t('workflows.cli.default')}</span>
            <span className="wf-cli-policy__summary-value">
              <CliIcon cli={defaultCli} />
              {defaultLabel}
            </span>
          </div>
          <div className="wf-cli-policy__summary-card">
            <span className="wf-cli-policy__summary-label">{t('workflows.cli.allowed')}</span>
            <span className="wf-cli-policy__summary-value">{allowed.length}</span>
          </div>
        </div>
        <div className="wf-cli-policy__toggle-icon" aria-hidden>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
      </button>

      {expanded ? (
        <div className="wf-cli-policy__body">
          <fieldset className="wf-cli-policy__fieldset wf-cli-policy__group">
            <legend className="wf-cli-policy__legend">{t('workflows.cli.default')}</legend>
            <div className="wf-cli-policy__options">
              {offered.map((o) => (
                <label
                  key={o.cli}
                  className={`wf-cli-option${defaultCli === o.cli ? ' wf-cli-option--active' : ''}`}
                >
                  <input
                    type="radio"
                    name="workflow-default-cli"
                    checked={defaultCli === o.cli}
                    onChange={() => pickDefault(o.cli)}
                    className="sr-only"
                  />
                  <CliIcon cli={o.cli} />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="wf-cli-policy__fieldset wf-cli-policy__group">
            <legend className="wf-cli-policy__legend">{t('workflows.cli.allowed')}</legend>
            <div className="wf-cli-policy__options">
              {offered.map((o) => {
                const isActive = allowed.includes(o.cli)
                return (
                  <label
                    key={o.cli}
                    className={`wf-cli-option${isActive ? ' wf-cli-option--active' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={() => toggleAllowed(o.cli)}
                      className="sr-only"
                    />
                    <CliIcon cli={o.cli} />
                    {o.label}
                    {isActive ? <CheckCircle2 size={12} aria-hidden className="ml-0.5" /> : null}
                  </label>
                )
              })}
            </div>
          </fieldset>

          <div className="wf-cli-policy__footer">
            <div className="wf-cli-policy__footer-status">
              {status === 'saved' ? (
                <span className="wf-cli-policy__status wf-cli-policy__status--saved">
                  <CheckCircle2 size={12} />
                  {t('workflows.cli.saved')}
                </span>
              ) : null}
              {status === 'error' ? (
                <span className="wf-cli-policy__status wf-cli-policy__status--error">
                  {t('workflows.cli.failed')}
                </span>
              ) : null}
              {!canSave && allowed.length === 0 ? (
                <span className="wf-cli-policy__status wf-cli-policy__status--error">
                  {t('workflows.cli.pickOne')}
                </span>
              ) : null}
              {!loaded ? (
                <span className="wf-cli-policy__status">
                  <Loader2 size={12} className="animate-spin" />
                  {t('workflows.loading')}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="drawer-action-btn wf-cli-policy__save pointer-coarse:min-h-9"
              onClick={handleSave}
              disabled={!canSave}
            >
              <ShieldCheck size={14} />
              {saving ? t('workflows.cli.saving') : t('workflows.cli.save')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
