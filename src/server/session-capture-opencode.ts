import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'
import { arePathsEqual, expandHomePath } from './platform-path.js'
import Database from './sqlite.js'

/**
 * Resolve the path OpenCode upstream writes `opencode.db` to. Branches
 * by platform because XDG_DATA_HOME is not a Windows convention — the
 * previous unconditional ~/.local/share/opencode/opencode.db default
 * pointed at a path that never exists on Windows, silently breaking
 * Layer A native session resume for OpenCode workers there.
 *
 * Resolution order:
 *   1. HIVE_OPENCODE_DB_PATH override (any platform, for tests/users).
 *   2. Windows: %LOCALAPPDATA%\opencode\opencode.db (with a homedir
 *      fallback when LOCALAPPDATA is missing — some shells strip env).
 *   3. POSIX: $XDG_DATA_HOME/opencode/opencode.db, falling back to
 *      ~/.local/share/opencode/opencode.db.
 *
 * Exported so the path-resolution rules can be unit-tested without
 * needing to mock the underlying SQLite open.
 */
export const getDefaultOpenCodeDbPath = (platform: NodeJS.Platform = process.platform): string => {
  const override = process.env.HIVE_OPENCODE_DB_PATH
  if (override) return override
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'opencode', 'opencode.db')
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
    'opencode',
    'opencode.db'
  )
}

export const getOpenCodeDbPath = (
  pattern?: string,
  platform: NodeJS.Platform = process.platform
) => {
  if (!pattern) return getDefaultOpenCodeDbPath(platform)
  const expanded = expandHomePath(pattern)
  if (
    arePathsEqual(expanded, join(homedir(), '.local', 'share', 'opencode', 'opencode.db'), platform)
  ) {
    return getDefaultOpenCodeDbPath(platform)
  }
  return expanded
}

const listSessionIds = (
  cwd: string,
  dbPath = getDefaultOpenCodeDbPath(),
  platform: NodeJS.Platform = process.platform
) => {
  if (!existsSync(dbPath)) return []
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readOnly: true })
    return (
      db
        .prepare(
          `SELECT id, directory FROM session
           WHERE time_archived IS NULL
           ORDER BY rowid ASC`
        )
        .all() as Array<{ directory: string; id: string }>
    )
      .filter((row) => arePathsEqual(row.directory, cwd, platform))
      .map((row) => row.id)
  } catch {
    return []
  } finally {
    db?.close()
  }
}

export const hasOpenCodeSession = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  platform: NodeJS.Platform = process.platform,
  dbPath = getOpenCodeDbPath(pattern, platform)
) => listSessionIds(cwd, dbPath, platform).includes(sessionId)

export const snapshotOpenCodeSessionIds = (
  cwd: string,
  dbPath = getDefaultOpenCodeDbPath(),
  platform: NodeJS.Platform = process.platform
) => new Set(listSessionIds(cwd, dbPath, platform))

export const captureOpenCodeSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  dbPath = getDefaultOpenCodeDbPath(),
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal
) => {
  await captureSessionIdWithCoordinator({
    signal,
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, dbPath, platform),
    onCapture,
    projectKey: `${dbPath}:${cwd}`,
    timeoutMs,
  })
}
