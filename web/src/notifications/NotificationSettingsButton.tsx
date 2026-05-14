import { Bell, Check, Info, Play, Volume2, VolumeX } from 'lucide-react'
import { useState } from 'react'

import type { NotificationDetail, NotificationSound } from './NotificationProvider.js'
import { useNotifications } from './NotificationProvider.js'

const soundOptions: Array<{
  accent: string
  description: string
  label: string
  length: 'short' | 'long' | 'silent'
  value: NotificationSound
}> = [
  {
    accent: 'var(--status-green)',
    description: 'Low and calm',
    label: 'Soft',
    length: 'short',
    value: 'soft',
  },
  {
    accent: 'var(--status-blue)',
    description: 'Short and crisp',
    label: 'Ping',
    length: 'short',
    value: 'ping',
  },
  {
    accent: 'var(--status-gold)',
    description: 'Two-note alert',
    label: 'Chime',
    length: 'short',
    value: 'chime',
  },
  {
    accent: 'var(--accent)',
    description: 'Four-note sweep',
    label: 'Cascade',
    length: 'long',
    value: 'cascade',
  },
  {
    accent: 'var(--status-orange)',
    description: 'Three-pulse signal',
    label: 'Beacon',
    length: 'long',
    value: 'beacon',
  },
  {
    accent: 'var(--status-purple)',
    description: 'Long resolved tone',
    label: 'Resolve',
    length: 'long',
    value: 'resolve',
  },
  {
    accent: 'var(--text-tertiary)',
    description: 'Mute sounds',
    label: 'Off',
    length: 'silent',
    value: 'off',
  },
]

const detailOptions: Array<{ description: string; label: string; value: NotificationDetail }> = [
  { description: 'Compact status line', label: 'Brief', value: 'brief' },
  { description: 'Workspace and queue context', label: 'Detailed', value: 'detailed' },
]

export const NotificationSettingsButton = () => {
  const [open, setOpen] = useState(false)
  const { notify, previewSound, requestDesktopNotifications, settings, updateSettings } =
    useNotifications()
  const desktopUnsupported = typeof window !== 'undefined' && !('Notification' in window)

  const handleDesktopChange = (checked: boolean) => {
    if (!checked) {
      updateSettings({ desktop: false })
      return
    }
    void requestDesktopNotifications()
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Notification settings"
        className="flex items-center gap-1.5 rounded px-3 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
        data-testid="topbar-settings"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={14} aria-hidden />
        <span>Notifications</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Notification settings"
          className="elev-2 absolute top-8 right-0 z-50 w-[380px] rounded-lg border p-3"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          data-testid="notification-settings"
        >
          <div className="mb-3 flex items-start gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-3 text-sec">
              <Bell size={16} aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="font-medium text-pri">Notifications</div>
              <div className="text-ter text-xs">
                Choose how Hive alerts you when team members report or stop.
              </div>
            </div>
          </div>

          <section className="mb-3">
            <div className="mb-2 flex items-center gap-1.5 text-ter text-xs uppercase tracking-wide">
              <Volume2 size={12} aria-hidden />
              Sound
            </div>
            <div role="radiogroup" aria-label="Sound" className="grid grid-cols-2 gap-2">
              {soundOptions.map((item) => (
                <div
                  key={item.value}
                  className="relative min-h-[78px] rounded-lg border transition-colors"
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
                  <label className="block h-full w-full cursor-pointer rounded-lg px-3 py-2 pr-10 text-left transition-colors hover:bg-3 focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--ring-focus)]">
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
                        className="flex h-5 w-5 items-center justify-center rounded-md"
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
                          longer
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
                      aria-label={`Preview ${item.label} sound`}
                      className="absolute right-2 bottom-2 flex h-6 w-6 items-center justify-center rounded-md border text-sec transition-colors hover:bg-3 hover:text-pri"
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
            <div className="mb-2 flex items-center gap-1.5 text-ter text-xs uppercase tracking-wide">
              <Info size={12} aria-hidden />
              Information
            </div>
            <div
              role="radiogroup"
              aria-label="Information"
              className="grid grid-cols-2 rounded-lg border p-1"
              style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
            >
              {detailOptions.map((item) => (
                <label
                  key={item.value}
                  className="cursor-pointer rounded-md px-3 py-2 text-left transition-colors hover:bg-3 focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--ring-focus)]"
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

          <label className="mb-3 flex items-start gap-2 rounded-md border p-2 text-sec text-xs">
            <input
              type="checkbox"
              aria-label="Browser notifications"
              checked={settings.desktop}
              disabled={desktopUnsupported}
              className="mt-0.5"
              onChange={(event) => handleDesktopChange(event.currentTarget.checked)}
            />
            <span>
              <span className="block font-medium text-pri">Browser notifications</span>
              <span className="text-ter">
                {desktopUnsupported
                  ? 'Not supported in this browser.'
                  : 'Use system notifications when permission is granted.'}
              </span>
            </span>
          </label>

          <div
            className="flex justify-end gap-2 border-t pt-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <button type="button" className="icon-btn" onClick={() => setOpen(false)}>
              Close
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--primary"
              onClick={() =>
                notify({
                  brief: 'Hive notifications are working.',
                  detail:
                    'Hive notifications are working with your selected sound and detail level.',
                  kind: 'success',
                  title: 'Hive notification test',
                })
              }
            >
              Test
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
