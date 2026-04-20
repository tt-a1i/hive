import type { Database } from 'better-sqlite3'

import { type AppStateRecord, type AppStateValue, createAppStateStore } from './app-state-store.js'
import {
  type CommandPresetInput,
  type CommandPresetRecord,
  createCommandPresetStore,
} from './command-preset-store.js'
import {
  createRoleTemplateStore,
  type RoleTemplateInput,
  type RoleTemplateRecord,
} from './role-template-store.js'

export interface SettingsStore {
  createCommandPreset: (input: CommandPresetInput) => CommandPresetRecord
  createRoleTemplate: (input: RoleTemplateInput) => RoleTemplateRecord
  deleteCommandPreset: (id: string) => void
  deleteRoleTemplate: (id: string) => void
  getAppState: (key: string) => AppStateRecord | undefined
  listCommandPresets: () => CommandPresetRecord[]
  listRoleTemplates: () => RoleTemplateRecord[]
  setAppState: (key: string, value: AppStateValue) => void
  updateCommandPreset: (id: string, input: CommandPresetInput) => CommandPresetRecord
  updateRoleTemplate: (id: string, input: RoleTemplateInput) => RoleTemplateRecord
}

export type {
  AppStateRecord,
  AppStateValue,
  CommandPresetInput,
  CommandPresetRecord,
  RoleTemplateInput,
  RoleTemplateRecord,
}

export const createSettingsStore = (db: Database | undefined): SettingsStore => {
  const appStateStore = createAppStateStore(db)
  const commandPresetStore = createCommandPresetStore(db)
  const roleTemplateStore = createRoleTemplateStore(db)

  return {
    createCommandPreset: commandPresetStore.create,
    createRoleTemplate: roleTemplateStore.create,
    deleteCommandPreset: commandPresetStore.remove,
    deleteRoleTemplate: roleTemplateStore.remove,
    getAppState: appStateStore.get,
    listCommandPresets: commandPresetStore.list,
    listRoleTemplates: roleTemplateStore.list,
    setAppState: appStateStore.set,
    updateCommandPreset: commandPresetStore.update,
    updateRoleTemplate: roleTemplateStore.update,
  }
}
