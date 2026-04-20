import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const listen = async (app: ReturnType<typeof createApp>) => {
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()))
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind to port')
  return `http://127.0.0.1:${address.port}`
}

describe('active workspace app_state', () => {
  test('active_workspace_id persists to sqlite and is restored after server restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-active-workspace-'))
    tempDirs.push(dataDir)
    const alphaPath = join(dataDir, 'alpha')
    const betaPath = join(dataDir, 'beta')
    mkdirSync(alphaPath, { recursive: true })
    mkdirSync(betaPath, { recursive: true })
    let betaId = ''

    const firstStore = createRuntimeStore({ dataDir })
    const firstApp = createApp({ store: firstStore })
    const firstBaseUrl = await listen(firstApp)
    try {
      const cookie = await getUiCookie(firstBaseUrl)
      const alphaResponse = await fetch(`${firstBaseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Alpha', path: alphaPath }),
      })
      expect(alphaResponse.status).toBe(201)
      const betaResponse = await fetch(`${firstBaseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Beta', path: betaPath }),
      })
      const beta = (await betaResponse.json()) as { id: string }
      betaId = beta.id

      const updateResponse = await fetch(
        `${firstBaseUrl}/api/settings/app-state/active_workspace_id`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ value: beta.id }),
        }
      )
      expect(updateResponse.status).toBe(204)

      const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      const row = db
        .prepare('SELECT value FROM app_state WHERE key = ?')
        .get('active_workspace_id') as { value: string | null }
      db.close()
      expect(row).toEqual({ value: beta.id })
    } finally {
      await firstStore.close()
      await new Promise<void>((resolve) => firstApp.server.close(() => resolve()))
    }

    const secondStore = createRuntimeStore({ dataDir })
    const secondApp = createApp({ store: secondStore })
    const secondBaseUrl = await listen(secondApp)
    try {
      const cookie = await getUiCookie(secondBaseUrl)
      const restoredResponse = await fetch(
        `${secondBaseUrl}/api/settings/app-state/active_workspace_id`,
        { headers: { cookie } }
      )
      const restored = (await restoredResponse.json()) as { key: string; value: string | null }
      expect(restored).toEqual({ key: 'active_workspace_id', value: betaId })
      const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
      const row = db
        .prepare('SELECT value FROM app_state WHERE key = ?')
        .get('active_workspace_id') as { value: string | null }
      db.close()
      expect(row.value).toBe(betaId)
    } finally {
      await secondStore.close()
      await new Promise<void>((resolve) => secondApp.server.close(() => resolve()))
    }
  })
})
