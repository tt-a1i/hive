export type UiLanguage = 'en' | 'zh'

export const UI_LANGUAGE_STORAGE_KEY = 'hive.uiLanguage'

export const isUiLanguage = (value: string | null): value is UiLanguage =>
  value === 'en' || value === 'zh'
