import { BookmarkPlus, Check, ChevronDown, Plus, RotateCcw, Search, SquareTerminal, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import type { CommandPreset, RoleTemplate } from '../api.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { CliAgentLogo } from './CliAgentAvatar.js'
import { RoleAvatar } from './RoleAvatar.js'

interface RoleCardSpec {
  value: WorkerRole
  dashed?: boolean
}

const ROLE_CARDS: RoleCardSpec[] = [
  { value: 'coder' },
  { value: 'reviewer' },
  { value: 'tester' },
]

const roleLabelKey = (role: WorkerRole) =>
  `role.${role}` as 'role.coder' | 'role.custom' | 'role.reviewer' | 'role.tester'

export const SectionLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-sm font-medium text-sec">{children}</span>
)

const RoleCard = ({
  active,
  spec,
  subtitle,
  useCount,
  onSelect,
}: {
  active: boolean
  spec: RoleCardSpec
  subtitle?: string | undefined
  useCount?: number | undefined
  onSelect: () => void
}) => {
  const { t } = useI18n()
  const label = t(roleLabelKey(spec.value))
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      data-testid={`role-card-${spec.value}`}
      className={`selectable-card${spec.dashed ? ' selectable-card--dashed' : ''}${active ? ' ring-1 ring-accent' : ''} relative flex items-center gap-3 px-3 py-2`}
    >
      <RoleAvatar role={spec.value} size={20} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-base font-medium text-pri">{label}</span>
        {subtitle ? (
          <span className="block truncate text-xs text-sec">{subtitle}</span>
        ) : null}
      </span>
      {useCount ? (
        <span className="text-xs text-ter">×{useCount}</span>
      ) : null}
      {active ? <Check size={14} className="shrink-0 text-accent" aria-hidden /> : null}
    </button>
  )
}

export const RolePicker = ({
  customTemplates,
  onRoleChange,
  onSelectTemplate,
  selectedTemplateName,
  selectedTemplateId,
  usedTemplateNames,
  workerRole,
}: {
  customTemplates: RoleTemplate[]
  onRoleChange: (value: WorkerRole) => void
  onSelectTemplate: (templateId: string) => void
  selectedTemplateName?: string | undefined
  selectedTemplateId: string | null
  usedTemplateNames?: Set<string> | undefined
  workerRole: WorkerRole
}) => {
  const { t } = useI18n()
  const templates = useMemo(
    () =>
      customTemplates
        .filter((tpl) => tpl.suggestedName || tpl.commandPresetId)
        .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0)),
    [customTemplates]
  )
  const roleOnlyTemplates = useMemo(
    () =>
      customTemplates
        .filter((tpl) => !tpl.suggestedName && !tpl.commandPresetId)
        .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0)),
    [customTemplates]
  )
  const sourceLabel = (source: 'builtin' | 'user' | 'external') => {
    if (source === 'external') return t('addWorker.templateSource.external')
    if (source === 'builtin') return t('addWorker.templateSource.builtin')
    return ''
  }
  return (
    <div className="flex flex-col gap-4">
      {templates.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>{t('addWorker.quickSelect')}</SectionLabel>
          <div
            className="grid grid-cols-2 gap-2"
            style={templates.length > 6 ? { maxHeight: 280, overflowY: 'auto' } : undefined}
          >
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => onSelectTemplate(tpl.id)}
                aria-pressed={selectedTemplateId === tpl.id}
                data-testid={`template-card-${tpl.id}`}
                className={`selectable-card flex items-center gap-3 px-3 py-2.5${selectedTemplateId === tpl.id ? ' ring-1 ring-accent' : ''}`}
              >
                <RoleAvatar role={tpl.roleType === 'orchestrator' ? 'custom' : tpl.roleType} size={20} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-medium text-pri">{tpl.name}</span>
                  <span className="flex gap-1.5">
                    {usedTemplateNames?.has(tpl.name) ? (
                      <span className="text-xs font-medium text-accent">In use</span>
                    ) : null}
                    {tpl.source !== 'user' ? (
                      <span className="truncate text-xs text-ter">{sourceLabel(tpl.source)}</span>
                    ) : null}
                  </span>
                </span>
                {tpl.useCount ? (
                  <span className="text-xs text-ter">×{tpl.useCount}</span>
                ) : null}
                {selectedTemplateId === tpl.id ? (
                  <Check size={14} className="shrink-0 text-accent" aria-hidden />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <SectionLabel>{t('addWorker.role')}</SectionLabel>
        <div
          className="grid grid-cols-3 gap-2"
          style={ROLE_CARDS.length + roleOnlyTemplates.length > 6 ? { maxHeight: 150, overflowY: 'auto' } : undefined}
        >
          {ROLE_CARDS.map((spec) => {
            const tpl = customTemplates.find((t) => t.roleType === spec.value && t.isBuiltin)
            return (
              <RoleCard
                key={spec.value}
                active={workerRole === spec.value && selectedTemplateId === null}
                spec={spec}
                useCount={tpl?.useCount}
                onSelect={() => onRoleChange(spec.value)}
              />
            )
          })}
          {roleOnlyTemplates.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => onSelectTemplate(tpl.id)}
              aria-pressed={selectedTemplateId === tpl.id}
              data-testid={`role-card-${tpl.id}`}
              className={`selectable-card selectable-card--dashed flex items-center gap-3 px-3 py-2${selectedTemplateId === tpl.id ? ' ring-1 ring-accent' : ''}`}
            >
              <RoleAvatar role="custom" size={20} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium text-pri">{tpl.name}</span>
                {tpl.source !== 'user' ? (
                  <span className="block truncate text-xs text-ter">{sourceLabel(tpl.source)}</span>
                ) : null}
              </span>
              {tpl.useCount ? (
                <span className="text-xs text-ter">×{tpl.useCount}</span>
              ) : null}
              {selectedTemplateId === tpl.id ? (
                <Check size={14} className="shrink-0 text-accent" aria-hidden />
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export const RoleTemplatePicker = ({
  customTemplates,
  disabledReason,
  onDeleteTemplate,
  onSelect,
  selectedTemplateId,
}: {
  customTemplates: RoleTemplate[]
  disabledReason?: string
  onDeleteTemplate: (templateId: string) => Promise<void> | void
  onSelect: (templateId: string | null) => void
  selectedTemplateId: string | null
}) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [deletingTemplate, setDeletingTemplate] = useState<RoleTemplate | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const selectedTemplate = useMemo(
    () => customTemplates.find((template) => template.id === selectedTemplateId) ?? null,
    [customTemplates, selectedTemplateId]
  )

  const filteredTemplates = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return customTemplates
    return customTemplates.filter(
      (template) =>
        template.name.toLowerCase().includes(trimmed) ||
        template.description.toLowerCase().includes(trimmed)
    )
  }, [customTemplates, query])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const handlePointer = (event: PointerEvent) => {
      const root = containerRef.current
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('pointerdown', handlePointer)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('pointerdown', handlePointer)
    }
  }, [open])

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{t('addWorker.template')}</SectionLabel>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid="role-template-picker-trigger"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-2 rounded border px-3 py-2 text-left text-sm transition-colors hover:bg-3"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
        >
          <span className="min-w-0 flex-1 truncate text-pri">
            {selectedTemplate ? selectedTemplate.name : t('addWorker.templatePickPlaceholder')}
          </span>
          <ChevronDown size={14} className="shrink-0 text-ter" aria-hidden />
        </button>
        {open ? (
          <div
            role="listbox"
            aria-label={t('addWorker.template')}
            data-testid="role-template-picker-menu"
            className="elev-2 absolute left-0 right-0 top-full z-30 mt-1 flex max-h-72 flex-col overflow-hidden rounded border"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <div
              className="flex items-center gap-2 border-b px-2 py-1.5"
              style={{ borderColor: 'var(--border)' }}
            >
              <Search size={14} className="text-ter" aria-hidden />
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t('addWorker.templateSearchPlaceholder')}
                data-testid="role-template-search-input"
                className="w-full bg-transparent text-sm text-pri outline-none placeholder:text-ter"
                spellCheck={false}
              />
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {customTemplates.length === 0 ? (
                <div
                  data-testid="role-template-empty-state"
                  className="px-3 py-3 text-center text-sm text-ter"
                >
                  {t('addWorker.templateEmpty')}
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className="px-3 py-3 text-center text-sm text-ter">
                  {t('addWorker.templateNoMatch')}
                </div>
              ) : (
                filteredTemplates.map((template) => {
                  const isSelected = template.id === selectedTemplateId
                  const isExternal = template.source === 'external'
                  return (
                    <div key={template.id} className="relative">
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        data-testid={`role-template-option-${template.id}`}
                        onClick={() => {
                          onSelect(template.id)
                          setOpen(false)
                          setQuery('')
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 pr-9 text-left text-sm text-pri hover:bg-3"
                        style={isSelected ? { background: 'var(--bg-3)' } : undefined}
                      >
                        <span className="min-w-0 flex-1 truncate">{template.name}</span>
                        {isExternal ? (
                          <span
                            data-testid={`role-template-external-badge-${template.id}`}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase"
                            style={{
                              color: 'var(--text-ter)',
                              background: 'var(--bg-3)',
                            }}
                          >
                            {t('addWorker.templateExternal')}
                          </span>
                        ) : null}
                        {isSelected ? (
                          <Check size={14} className="shrink-0 text-accent" aria-hidden />
                        ) : null}
                      </button>
                      {!template.readonly ? (
                        <button
                          type="button"
                          aria-label={t('addWorker.templateDeleteAria', { name: template.name })}
                          data-testid={`role-template-delete-${template.id}`}
                          disabled={Boolean(disabledReason)}
                          title={disabledReason ?? undefined}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            if (disabledReason) return
                            setDeletingTemplate(template)
                          }}
                          className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ter transition-colors hover:bg-3 hover:text-pri"
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
            {selectedTemplateId !== null ? (
              <button
                type="button"
                data-testid="role-template-clear"
                onClick={() => {
                  onSelect(null)
                  setOpen(false)
                  setQuery('')
                }}
                className="border-t px-3 py-1.5 text-left text-sm text-ter transition-colors hover:bg-3 hover:text-pri"
                style={{ borderColor: 'var(--border)' }}
              >
                {t('addWorker.templateClear')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Confirm
        open={deletingTemplate !== null}
        onOpenChange={(value) => {
          if (!value) setDeletingTemplate(null)
        }}
        title={t('addWorker.templateDeleteTitle')}
        description={
          deletingTemplate
            ? t('addWorker.templateDeleteConfirm', { name: deletingTemplate.name })
            : ''
        }
        confirmLabel={t('addWorker.templateDeleteConfirmLabel')}
        confirmKind="danger"
        onConfirm={() => {
          if (!deletingTemplate || disabledReason) return
          const id = deletingTemplate.id
          setDeletingTemplate(null)
          void onDeleteTemplate(id)
        }}
      />
    </div>
  )
}

export const RoleInstructionsField = ({
  canSaveAsTemplate,
  modified,
  onChange,
  onReset,
  onSaveAsTemplate,
  roleDescription,
  templateBusy,
  workerRole,
  writeDisabledReason,
}: {
  canSaveAsTemplate: boolean
  modified: boolean
  onChange: (value: string) => void
  onReset: () => void
  onSaveAsTemplate: (name: string) => Promise<void> | void
  roleDescription: string
  templateBusy: boolean
  workerRole: WorkerRole
  writeDisabledReason?: string | undefined
}) => {
  const { t } = useI18n()
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [templateName, setTemplateName] = useState('')
  useEffect(() => {
    if (workerRole === 'custom' || modified) setInstructionsOpen(true)
  }, [modified, workerRole])
  useEffect(() => {
    if (!canSaveAsTemplate) {
      setSaving(false)
      setTemplateName('')
    }
  }, [canSaveAsTemplate])

  return (
    <details
      open={instructionsOpen}
      onToggle={(event) => setInstructionsOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="group flex flex-col gap-2"
    >
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 list-none">
        <span className="flex items-center gap-1.5">
          <ChevronDown
            size={12}
            aria-hidden
            className="-rotate-90 text-ter transition-transform duration-150 group-open:rotate-0"
          />
          <SectionLabel>{t('addWorker.roleInstructions')}</SectionLabel>
          {modified ? (
            <span className="text-sm text-ter">
              · {t('addWorker.modifiedFrom', { role: t(roleLabelKey(workerRole)) })}
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-1">
          {canSaveAsTemplate && !saving ? (
            <button
              type="button"
              data-testid="role-template-save"
              disabled={Boolean(writeDisabledReason)}
              title={writeDisabledReason ?? undefined}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setSaving(true)
              }}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                color: 'var(--accent)',
                background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
              }}
            >
              <BookmarkPlus size={12} aria-hidden />
              {t('addWorker.saveAsTemplate')}
            </button>
          ) : null}
          {modified ? (
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ter transition-colors hover:bg-3 hover:text-sec"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onReset()
              }}
            >
              <RotateCcw size={12} aria-hidden />
              {t('addWorker.reset')}
            </button>
          ) : null}
        </div>
      </summary>
      <textarea
        aria-label="Role instructions"
        id="add-worker-role-instructions"
        value={roleDescription}
        rows={5}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={workerRole === 'custom' ? t('addWorker.customPlaceholder') : undefined}
        title={t('addWorker.roleInstructionsTitle')}
        className="input mono resize-y text-sm"
        style={{ minHeight: 150 }}
        data-testid="role-instructions-textarea"
      />
      {canSaveAsTemplate && saving ? (
        <div className="flex items-center gap-2">
          <input
            // biome-ignore lint/a11y/noAutofocus: opt-in inline prompt; focus the new field so the user can type immediately
            autoFocus
            value={templateName}
            onChange={(event) => setTemplateName(event.currentTarget.value)}
            placeholder={t('addWorker.templateNamePlaceholder')}
            data-testid="role-template-save-name"
            className="input flex-1 text-sm"
          />
          <button
            type="button"
            disabled={templateBusy || !templateName.trim() || Boolean(writeDisabledReason)}
            title={writeDisabledReason ?? undefined}
            data-testid="role-template-save-confirm"
            onClick={async () => {
              if (writeDisabledReason) return
              const name = templateName.trim()
              if (!name) return
              try {
                await onSaveAsTemplate(name)
                setSaving(false)
                setTemplateName('')
              } catch {
                // Error is surfaced by the composer; leave the prompt open so
                // the user can correct the name and retry.
              }
            }}
            className="icon-btn icon-btn--primary text-xs"
          >
            {t('addWorker.templateSaveConfirm')}
          </button>
          <button
            type="button"
            data-testid="role-template-save-cancel"
            onClick={() => {
              setSaving(false)
              setTemplateName('')
            }}
            className="icon-btn text-xs"
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : null}
    </details>
  )
}

const AgentChip = ({
  active,
  command,
  displayName,
  logoPresetId,
  notFound = false,
  testId,
  onSelect,
}: {
  active: boolean
  command: string
  displayName: string
  logoPresetId?: string | undefined
  notFound?: boolean
  testId: string
  onSelect: () => void
}) => {
  const { t } = useI18n()
  const fallbackIcon = (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-surface-1 text-ter"
      data-testid={`${testId}-generic-icon`}
      aria-hidden
    >
      <SquareTerminal size={13} />
    </span>
  )
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      data-testid={testId}
      className="selectable-card flex items-center justify-between gap-3 px-3 py-2"
    >
      <span className="flex min-w-0 items-center gap-3">
        <CliAgentLogo commandPresetId={logoPresetId} fallback={fallbackIcon} size={22} />
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <span className="truncate text-base font-medium text-pri">{displayName}</span>
          <span className="mono truncate text-xs text-ter">
            {command}
            {notFound ? ` · ${t('addWorker.agentNotFound')}` : ''}
          </span>
        </span>
      </span>
      {active ? <Check size={14} className="shrink-0 text-accent" aria-hidden /> : null}
    </button>
  )
}

const PresetAgentChip = ({
  active,
  preset,
  onSelect,
}: {
  active: boolean
  preset: CommandPreset
  onSelect: () => void
}) => (
  <AgentChip
    active={active}
    command={preset.command}
    displayName={preset.displayName}
    logoPresetId={preset.id}
    notFound={preset.available === false}
    testId={`agent-radio-${preset.id}`}
    onSelect={onSelect}
  />
)

export const AgentCliPicker = ({
  commandPresetId,
  commandPresets,
  onPresetChange,
}: {
  commandPresetId: string
  commandPresets: CommandPreset[]
  onPresetChange: (value: string) => void
}) => (
  <AgentCliPickerInner
    commandPresetId={commandPresetId}
    commandPresets={commandPresets}
    onPresetChange={onPresetChange}
  />
)

const AgentCliPickerInner = ({
  commandPresetId,
  commandPresets,
  onPresetChange,
}: {
  commandPresetId: string
  commandPresets: CommandPreset[]
  onPresetChange: (value: string) => void
}) => {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{t('addWorker.agentCli')}</SectionLabel>
      {commandPresets.length === 0 ? (
        <div className="text-sm text-ter">{t('addWorker.loadingPresets')}</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {commandPresets.map((preset) => (
            <PresetAgentChip
              key={preset.id}
              active={commandPresetId === preset.id}
              preset={preset}
              onSelect={() => onPresetChange(preset.id)}
            />
          ))}
          <AgentChip
            active={commandPresetId === ''}
            command={t('addWorker.genericCommand')}
            displayName={t('addWorker.genericAgent')}
            testId="agent-radio-generic"
            onSelect={() => onPresetChange('')}
          />
        </div>
      )}
    </div>
  )
}

export const StartupCommandField = ({
  onChange,
  value,
}: {
  onChange: (value: string) => void
  value: string
}) => {
  const { t } = useI18n()
  const clean = value.trim()
  return (
    <details className="group flex flex-col gap-2">
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 list-none">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronDown
            size={12}
            aria-hidden
            className="-rotate-90 shrink-0 text-ter transition-transform duration-150 group-open:rotate-0"
          />
          <SectionLabel>{t('addWorker.startupCommand')}</SectionLabel>
          {clean ? (
            <span className="truncate text-sm text-ter">· {t('addWorker.startupOverrides')}</span>
          ) : null}
        </span>
      </summary>
      <div
        className="flex flex-col gap-2 rounded border bg-2 p-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <input
          aria-label="Startup command"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder="qwen --model qwen3-coder"
          className="input mono text-sm"
          spellCheck={false}
        />
        <p className="text-sm leading-5 text-ter">
          {t('addWorker.startupHelp', { example: 'claude --resume <session-id>' })}
        </p>
      </div>
    </details>
  )
}
