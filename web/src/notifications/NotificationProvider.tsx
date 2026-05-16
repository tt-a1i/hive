import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n.js'
import type { ToastKind } from '../ui/useToast.js'
import { useToast } from '../ui/useToast.js'

export type NotificationSound = 'off' | 'soft' | 'ping' | 'chime' | 'cascade' | 'beacon' | 'resolve'
export type NotificationDetail = 'brief' | 'detailed'

export interface NotificationSettings {
  desktop: boolean
  detail: NotificationDetail
  sound: NotificationSound
}

export interface NotifyOptions {
  brief: string
  detail?: string
  kind: ToastKind
  title: string
}

interface NotificationApi {
  notify: (options: NotifyOptions) => void
  previewSound: (sound: NotificationSound) => void
  requestDesktopNotifications: () => Promise<boolean>
  settings: NotificationSettings
  updateSettings: (patch: Partial<NotificationSettings>) => void
}

export const NOTIFICATION_SETTINGS_KEY = 'hive.notification.settings'

const DEFAULT_SETTINGS: NotificationSettings = {
  desktop: false,
  detail: 'brief',
  sound: 'soft',
}

type SoundProfile = {
  notes: Array<{ at: number; frequency: number }>
  noteDuration: number
  peak: number
  totalDuration: number
  type: OscillatorType
}

const soundProfiles: Record<Exclude<NotificationSound, 'off'>, SoundProfile> = {
  beacon: {
    noteDuration: 0.18,
    notes: [
      { at: 0, frequency: 392 },
      { at: 0.22, frequency: 392 },
      { at: 0.44, frequency: 587.33 },
    ],
    peak: 0.075,
    totalDuration: 0.72,
    type: 'sine',
  },
  cascade: {
    noteDuration: 0.15,
    notes: [
      { at: 0, frequency: 783.99 },
      { at: 0.16, frequency: 659.25 },
      { at: 0.32, frequency: 523.25 },
      { at: 0.48, frequency: 392 },
    ],
    peak: 0.07,
    totalDuration: 0.78,
    type: 'triangle',
  },
  chime: {
    noteDuration: 0.13,
    notes: [
      { at: 0, frequency: 523.25 },
      { at: 0.055, frequency: 659.25 },
    ],
    peak: 0.08,
    totalDuration: 0.19,
    type: 'triangle',
  },
  ping: {
    noteDuration: 0.08,
    notes: [{ at: 0, frequency: 880 }],
    peak: 0.08,
    totalDuration: 0.08,
    type: 'sine',
  },
  resolve: {
    noteDuration: 0.2,
    notes: [
      { at: 0, frequency: 329.63 },
      { at: 0.18, frequency: 392 },
      { at: 0.36, frequency: 493.88 },
      { at: 0.58, frequency: 659.25 },
    ],
    peak: 0.065,
    totalDuration: 0.9,
    type: 'triangle',
  },
  soft: {
    noteDuration: 0.11,
    notes: [{ at: 0, frequency: 440 }],
    peak: 0.08,
    totalDuration: 0.11,
    type: 'sine',
  },
}

const isNotificationSound = (sound: unknown): sound is NotificationSound =>
  sound === 'off' ||
  sound === 'ping' ||
  sound === 'chime' ||
  sound === 'soft' ||
  sound === 'cascade' ||
  sound === 'beacon' ||
  sound === 'resolve'

const readSettings = (): NotificationSettings => {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>
    return {
      desktop: typeof parsed.desktop === 'boolean' ? parsed.desktop : DEFAULT_SETTINGS.desktop,
      detail: parsed.detail === 'detailed' ? 'detailed' : DEFAULT_SETTINGS.detail,
      sound: isNotificationSound(parsed.sound) ? parsed.sound : DEFAULT_SETTINGS.sound,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const writeSettings = (settings: NotificationSettings) => {
  try {
    window.localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // localStorage can be disabled; notification preferences are best-effort UI state.
  }
}

const playSound = (sound: NotificationSound) => {
  if (sound === 'off' || typeof window === 'undefined') return
  const audioWindow = window as Window & {
    webkitAudioContext?: typeof AudioContext
  }
  const AudioCtor = window.AudioContext ?? audioWindow.webkitAudioContext
  if (!AudioCtor) return
  try {
    const context = new AudioCtor()
    const profile = soundProfiles[sound]
    const gain = context.createGain()
    gain.connect(context.destination)
    gain.gain.cancelScheduledValues(context.currentTime)
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(profile.peak, context.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + profile.totalDuration)

    profile.notes.forEach(({ at, frequency }) => {
      const oscillator = context.createOscillator()
      oscillator.type = profile.type
      oscillator.frequency.setValueAtTime(frequency, context.currentTime + at)
      oscillator.connect(gain)
      oscillator.start(context.currentTime + at)
      oscillator.stop(context.currentTime + at + profile.noteDuration)
    })
  } catch {
    // Browsers can block Web Audio until a user gesture; failed sound should not block work.
  }
}

const NotificationContext = createContext<NotificationApi | null>(null)

export const NotificationProvider = ({ children }: { children: ReactNode }) => {
  const toast = useToast()
  const { t } = useI18n()
  const [settings, setSettings] = useState<NotificationSettings>(() => readSettings())

  useEffect(() => {
    writeSettings(settings)
  }, [settings])

  const updateSettings = useCallback((patch: Partial<NotificationSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
  }, [])

  const requestDesktopNotifications = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      updateSettings({ desktop: false })
      toast.show({ kind: 'warning', message: t('notifications.toast.unsupported') })
      return false
    }
    if (window.Notification.permission === 'granted') {
      updateSettings({ desktop: true })
      return true
    }
    if (window.Notification.permission === 'denied') {
      updateSettings({ desktop: false })
      toast.show({ kind: 'warning', message: t('notifications.toast.blocked') })
      return false
    }
    const permission = await window.Notification.requestPermission()
    const granted = permission === 'granted'
    updateSettings({ desktop: granted })
    if (!granted) toast.show({ kind: 'warning', message: t('notifications.toast.declined') })
    return granted
  }, [t, toast, updateSettings])

  const notify = useCallback(
    ({ brief, detail, kind, title }: NotifyOptions) => {
      const message = settings.detail === 'detailed' && detail ? detail : brief
      toast.show({ kind, message })
      playSound(settings.sound)
      if (
        settings.desktop &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        window.Notification.permission === 'granted'
      ) {
        try {
          new window.Notification(title, { body: message })
        } catch {
          // Desktop notifications can fail per-browser; toast remains the reliable channel.
        }
      }
    },
    [settings, toast]
  )

  const previewSound = useCallback((sound: NotificationSound) => {
    playSound(sound)
  }, [])

  const value = useMemo<NotificationApi>(
    () => ({ notify, previewSound, requestDesktopNotifications, settings, updateSettings }),
    [notify, previewSound, requestDesktopNotifications, settings, updateSettings]
  )

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
}

export const useNotifications = (): NotificationApi => {
  const context = useContext(NotificationContext)
  if (!context) throw new Error('useNotifications must be used within NotificationProvider')
  return context
}
