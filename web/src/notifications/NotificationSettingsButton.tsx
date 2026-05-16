import { Bell, Check, Info, Play, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import type { NotificationDetail, NotificationSound } from './NotificationProvider.js'
import { useNotifications } from './NotificationProvider.js'

interface SoundOption {
  accent: string
  descriptionKey: TranslationKey
  labelKey: TranslationKey
  length: 'short' | 'long' | 'silent'
  value: NotificationSound
}

interface DetailOption {
  descriptionKey: TranslationKey
  labelKey: TranslationKey
  value: NotificationDetail
}

const SOUND_OPTIONS: SoundOption[] = [
  {
    accent: 'var(--status-green)',
    descriptionKey: 'notifications.sound.soft.description',
    labelKey: 'notifications.sound.soft.label',
    length: 'short',
    value: 'soft',
  },
  {
    accent: 'var(--status-blue)',
    descriptionKey: 'notifications.sound.ping.description',
    labelKey: 'notifications.sound.ping.label',
    length: 'short',
    value: 'ping',
  },
  {
    accent: 'var(--status-gold)',
    descriptionKey: 'notifications.sound.chime.description',
    labelKey: 'notifications.sound.chime.label',
    length: 'short',
    value: 'chime',
  },
  {
    accent: 'var(--accent)',
    descriptionKey: 'notifications.sound.cascade.description',
    labelKey: 'notifications.sound.cascade.label',
    length: 'long',
    value: 'cascade',
  },
  {
    accent: 'var(--status-orange)',
    descriptionKey: 'notifications.sound.beacon.description',
    labelKey: 'notifications.sound.beacon.label',
    length: 'long',
    value: 'beacon',
  },
  {
    accent: 'var(--status-purple)',
    descriptionKey: 'notifications.sound.resolve.description',
    labelKey: 'notifications.sound.resolve.label',
    length: 'long',
    value: 'resolve',
  },
  {
    accent: 'var(--text-tertiary)',
    descriptionKey: 'notifications.sound.off.description',
    labelKey: 'notifications.sound.off.label',
    length: 'silent',
    value: 'off',
  },
]

const DETAIL_OPTIONS: DetailOption[] = [
  {
    descriptionKey: 'notifications.detail.brief.description',
    labelKey: 'notifications.detail.brief.label',
    value: 'brief',
  },
  {
    descriptionKey: 'notifications.detail.detailed.description',
    labelKey: 'notifications.detail.detailed.label',
    value: 'detailed',
  },
]

export const NotificationSettingsButton = () => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { notify, previewSound, requestDesktopNotifications, settings, updateSettings } =
    useNotifications()
  const desktopUnsupported = typeof window !== 'undefined' && !('Notification' in window)

  // Memoize translated option rows so each render of the popover doesn't
  // re-create the array. Keys depend on the current language (re-derived via
  // `t`), so language switches do invalidate the cache as expected.
  const soundOptions = useMemo(
    () =>
      SOUND_OPTIONS.map((option) => ({
        ...option,
        description: t(option.descriptionKey),
        label: t(option.labelKey),
      })),
    [t]
  )
  const detailOptions = useMemo(
    () =>
      DETAIL_OPTIONS.map((option) => ({
        ...option,
        description: t(option.descriptionKey),
        label: t(option.labelKey),
      })),
    [t]
  )

  const handleDesktopChange = (checked: boolean) => {
    if (!checked) {
      updateSettings({ desktop: false })
      return
    }
    void requestDesktopNotifications()
  }

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
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
    <div ref={containerRef} className="relative">
      <Tooltip label={t('notifications.settings.tooltip')}>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('notifications.settings.aria')}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-sec hover:bg-3 hover:text-pri"
          data-testid="topbar-settings"
          onClick={() => setOpen((value) => !value)}
        >
          <Bell size={14} aria-hidden />
        </button>
      </Tooltip>
      {open ? (
        <div
          role="dialog"
          aria-label={t('notifications.settings.aria')}
          className="elev-2 absolute top-8 right-0 z-50 w-[380px] rounded border p-3"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          data-testid="notification-settings"
        >
          <div className="mb-3 flex items-start gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-3 text-sec">
              <Bell size={16} aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-pri">
                {t('notifications.settings.heading')}
              </div>
              <div className="text-ter text-xs">{t('notifications.settings.subtitle')}</div>
            </div>
          </div>

          <section className="mb-3">
            <div className="mb-2 flex items-center gap-1.5 text-ter text-xs uppercase tracking-wider">
              <Volume2 size={12} aria-hidden />
              {t('notifications.sound.sectionLabel')}
            </div>
            <div
              role="radiogroup"
              aria-label={t('notifications.sound.sectionLabel')}
              className="grid grid-cols-2 gap-2"
            >
              {soundOptions.map((item) => (
                <div
                  key={item.value}
                  className="relative min-h-[78px] rounded border transition-colors"
                  style={{
                    background:
                      settings.sound === item.value
                        ? `color-mix(in oklab, ${item.accent} 10%, var(--bg-2))`
                        : 'var(--bg-2)',
                    borderColor:
                      settings.sound === item.value
                        ? `color-mix(in oklab, ${item.accent} 54%, var(--border-bright))`
                        : 'var(--border)',
                  }}
                >
                  <label className="block h-full w-full cursor-pointer rounded px-3 py-2 pr-10 text-left transition-colors hover:bg-3 focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--ring-focus)]">
                    <input
                      type="radio"
                      name="notification-sound"
                      value={item.value}
                      checked={settings.sound === item.value}
                      className="sr-only"
                      onChange={() => updateSettings({ sound: item.value })}
                    />
                    <span className="mb-1 flex items-center gap-2">
                      <span
                        className="flex h-5 w-5 items-center justify-center rounded"
                        style={{
                          background: `color-mix(in oklab, ${item.accent} 16%, transparent)`,
                          color: item.accent,
                        }}
                      >
                        {item.value === 'off' ? (
                          <VolumeX size={12} aria-hidden />
                        ) : (
                          <Volume2 size={12} aria-hidden />
                        )}
                      </span>
                      <span className="font-medium text-pri text-xs">{item.label}</span>
                      {item.length === 'long' ? (
                        <span className="rounded border border-[var(--border-bright)] px-1.5 py-0.5 text-xs text-ter uppercase">
                          {t('notifications.sound.longerBadge')}
                        </span>
                      ) : null}
                      {settings.sound === item.value ? (
                        <Check size={12} className="ml-auto text-pri" aria-hidden />
                      ) : null}
                    </span>
                    <span className="block text-ter text-xs">{item.description}</span>
                  </label>
                  {item.value !== 'off' ? (
                    <button
                      type="button"
                      aria-label={t('notifications.sound.previewAria', { label: item.label })}
                      className="absolute right-2 bottom-2 flex h-6 w-6 items-center justify-center rounded border text-sec transition-colors hover:bg-3 hover:text-pri"
                      style={{ borderColor: 'var(--border-bright)' }}
                      onClick={() => previewSound(item.value)}
                    >
                      <Play size={12} aria-hidden />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section className="mb-3">
            <div className="mb-2 flex items-center gap-1.5 text-ter text-xs uppercase tracking-wider">
              <Info size={12} aria-hidden />
              {t('notifications.detail.sectionLabel')}
            </div>
            <div
              role="radiogroup"
              aria-label={t('notifications.detail.sectionLabel')}
              className="grid grid-cols-2 rounded border p-1"
              style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
            >
              {detailOptions.map((item) => (
                <label
                  key={item.value}
                  className="cursor-pointer rounded px-3 py-2 text-left transition-colors hover:bg-3 focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--ring-focus)]"
                  style={{
                    background: settings.detail === item.value ? 'var(--bg-3)' : 'transparent',
                    color:
                      settings.detail === item.value
                        ? 'var(--text-primary)'
                        : 'var(--text-secondary)',
                  }}
                >
                  <input
                    type="radio"
                    name="notification-detail"
                    value={item.value}
                    checked={settings.detail === item.value}
                    className="sr-only"
                    onChange={() => updateSettings({ detail: item.value })}
                  />
                  <span className="block font-medium text-xs">{item.label}</span>
                  <span className="block text-ter text-xs">{item.description}</span>
                </label>
              ))}
            </div>
          </section>

          <label className="mb-3 flex items-start gap-2 rounded border p-2 text-sec text-xs">
            <input
              type="checkbox"
              aria-label={t('notifications.desktop.aria')}
              checked={settings.desktop}
              disabled={desktopUnsupported}
              className="mt-0.5"
              onChange={(event) => handleDesktopChange(event.currentTarget.checked)}
            />
            <span>
              <span className="block font-medium text-pri">{t('notifications.desktop.label')}</span>
              <span className="text-ter">
                {desktopUnsupported
                  ? t('notifications.desktop.unsupported')
                  : t('notifications.desktop.helper')}
              </span>
            </span>
          </label>

          <div
            className="flex justify-end gap-2 border-t pt-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <button type="button" className="icon-btn" onClick={() => setOpen(false)}>
              {t('common.close')}
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--primary"
              onClick={() =>
                notify({
                  brief: t('notifications.test.brief'),
                  detail: t('notifications.test.detail'),
                  kind: 'success',
                  title: t('notifications.test.title'),
                })
              }
            >
              {t('notifications.test.button')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
