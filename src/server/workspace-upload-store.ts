import { randomUUID } from 'node:crypto'
import { readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { HttpError } from './http-errors.js'
import type { Database } from './sqlite.js'

export interface SaveWorkspaceUploadInput {
  workspaceId: string
  remoteDeviceId?: string | null
  originalName: string
  mimeType?: string | null
  data: Buffer
}

export interface WorkspaceUploadRecord {
  id: string
  workspaceId: string
  remoteDeviceId: string | null
  originalName: string
  mimeType: string
  sizeBytes: number
  createdAt: number
}

interface WorkspaceUploadRow {
  id: string
  workspace_id: string
  remote_device_id: string | null
  original_name: string
  mime_type: string
  size_bytes: number
  storage_key: string
  created_at: number
}

const DEFAULT_UPLOAD_NAME = 'upload'
const DEFAULT_MIME_TYPE = 'application/octet-stream'
const MAX_NAME_LENGTH = 180
const MAX_MIME_TYPE_LENGTH = 120
const MIME_TYPE_RE =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/

const stripControlCharacters = (value: string): string => {
  let result = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code >= 32 && code !== 127) result += char
  }
  return result
}

const isSafeHeaderValue = (value: string): boolean => {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 32 || code > 126 || code === 127) return false
  }
  return true
}

const mapRow = (row: WorkspaceUploadRow): WorkspaceUploadRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  remoteDeviceId: row.remote_device_id,
  originalName: row.original_name,
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
  createdAt: row.created_at,
})

export const truncateUploadFilename = (value: string, maxLength: number): string => {
  // Keep the UTF-16 budget, but exclude a scalar whose pair crosses the cut.
  const splitsPair = (value.codePointAt(maxLength - 1) ?? 0) > 0xffff
  return value.slice(0, splitsPair ? maxLength - 1 : maxLength)
}

const sanitizeOriginalName = (value: string): string => {
  const leaf = stripControlCharacters(basename(value.replaceAll('\\', '/')))
    .trim()
    .replace(/\s+/g, ' ')
  return leaf ? truncateUploadFilename(leaf, MAX_NAME_LENGTH) : DEFAULT_UPLOAD_NAME
}

const sanitizeMimeType = (value: string | null | undefined): string => {
  if (!value) return DEFAULT_MIME_TYPE
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed.length > MAX_MIME_TYPE_LENGTH ||
    !isSafeHeaderValue(trimmed) ||
    !MIME_TYPE_RE.test(trimmed)
  ) {
    return DEFAULT_MIME_TYPE
  }
  return trimmed
}

const safeStorageExtension = (originalName: string): string => {
  const extension = extname(originalName)
  if (!extension || extension.length > 16) return ''
  // Require at least one non-dot character: `extname('foo.')` returns `'.'`,
  // and win32 silently strips trailing dots on disk, so the stored name would
  // no longer round-trip with `storage_key`.
  return /^\.[A-Za-z0-9_-]+$/.test(extension) ? extension : ''
}

const isEnoent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

const createStorageKey = (workspaceId: string, uploadId: string, originalName: string): string =>
  `${workspaceId}/${uploadId}${safeStorageExtension(originalName)}`

const resolveStoragePath = (uploadsDir: string, storageKey: string): string => {
  const root = resolve(uploadsDir)
  const candidate = resolve(root, ...storageKey.split('/'))
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new HttpError(500, 'Upload storage key is invalid')
  }
  return candidate
}

const readRowDataStrict = async (
  uploadsDir: string,
  row: WorkspaceUploadRow
): Promise<Buffer | null> => {
  try {
    return await readFile(resolveStoragePath(uploadsDir, row.storage_key))
  } catch (error) {
    if (isEnoent(error)) return null
    throw new HttpError(500, 'Upload file could not be read')
  }
}

const pruneWorkspaceUploadDir = (uploadsDir: string, workspaceId: string): void => {
  try {
    rmdirSync(resolveStoragePath(uploadsDir, workspaceId))
  } catch {
    // Directory may be absent already, or may contain files from a concurrent upload.
  }
}

const removeFile = (path: string): void => {
  try {
    unlinkSync(path)
  } catch {
    // Best-effort cleanup only. A missing or locked file should not block
    // workspace deletion or rollback from a failed metadata insert.
  }
}

const restoreStagedFiles = (staged: Array<{ originalPath: string; stagedPath: string }>): void => {
  for (let index = staged.length - 1; index >= 0; index -= 1) {
    const item = staged[index]
    if (!item) continue
    try {
      renameSync(item.stagedPath, item.originalPath)
    } catch {
      // Best effort: if rollback restoration fails, preserve the original
      // exception because it names the operation that made deletion unsafe.
    }
  }
}

const STAGED_DELETE_SUFFIX_RE =
  /\.deleting-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Reconcile `.deleting-*` tombstones left by a crash between staging and the
 * surrounding transaction outcome: a surviving DB row means the delete rolled
 * back, so the blob is restored; no row means it committed, so the blob goes.
 */
const sweepStagedUploadFiles = (db: Database, uploadsDir: string): void => {
  const hasRowForStorageKey = db.prepare('SELECT 1 FROM workspace_uploads WHERE storage_key = ?')
  let workspaceDirs: string[]
  try {
    workspaceDirs = readdirSync(uploadsDir)
  } catch {
    return
  }
  for (const workspaceId of workspaceDirs) {
    let entries: string[]
    try {
      entries = readdirSync(join(uploadsDir, workspaceId))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!STAGED_DELETE_SUFFIX_RE.test(entry)) continue
      const stagedPath = join(uploadsDir, workspaceId, entry)
      const originalName = entry.replace(STAGED_DELETE_SUFFIX_RE, '')
      try {
        if (hasRowForStorageKey.get(`${workspaceId}/${originalName}`)) {
          renameSync(stagedPath, join(uploadsDir, workspaceId, originalName))
        } else {
          unlinkSync(stagedPath)
        }
      } catch {
        // Locked or vanished tombstones wait for the next boot.
      }
    }
  }
}

export interface StagedWorkspaceUploadsDelete {
  /** Permanently remove the staged blobs once the transaction has committed. */
  commit: () => void
  /** Restore the staged blobs after the surrounding transaction rolled back. */
  rollback: () => void
}

const stageFilesForDelete = (
  uploadsDir: string,
  rows: WorkspaceUploadRow[]
): Array<{ originalPath: string; stagedPath: string }> => {
  const staged: Array<{ originalPath: string; stagedPath: string }> = []
  try {
    for (const row of rows) {
      const originalPath = resolveStoragePath(uploadsDir, row.storage_key)
      const stagedPath = `${originalPath}.deleting-${randomUUID()}`
      try {
        renameSync(originalPath, stagedPath)
      } catch (error) {
        if (isEnoent(error)) continue
        throw error
      }
      staged.push({ originalPath, stagedPath })
    }
  } catch (error) {
    restoreStagedFiles(staged)
    if (error instanceof HttpError) throw error
    throw new HttpError(500, 'Workspace upload file could not be deleted')
  }
  return staged
}

export const createWorkspaceUploadStore = (db: Database, uploadsDir: string) => {
  const insertUpload = db.prepare(
    `INSERT INTO workspace_uploads (
       id, workspace_id, remote_device_id, original_name, mime_type, size_bytes, storage_key,
       created_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?)`
  )
  const workspaceExists = db.prepare('SELECT 1 FROM workspaces WHERE id = ?')
  const getUpload = db.prepare(
    `SELECT id, workspace_id, remote_device_id, original_name, mime_type, size_bytes, storage_key,
            created_at
       FROM workspace_uploads
      WHERE workspace_id = ? AND id = ?`
  )
  const listUploads = db.prepare(
    `SELECT id, workspace_id, remote_device_id, original_name, mime_type, size_bytes, storage_key,
            created_at
       FROM workspace_uploads
      WHERE workspace_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  )
  const listUploadsForDelete = db.prepare(
    `SELECT id, workspace_id, remote_device_id, original_name, mime_type, size_bytes, storage_key,
            created_at
       FROM workspace_uploads
      WHERE workspace_id = ?`
  )
  const deleteWorkspaceRows = db.prepare('DELETE FROM workspace_uploads WHERE workspace_id = ?')

  sweepStagedUploadFiles(db, uploadsDir)

  return {
    async saveUpload(input: SaveWorkspaceUploadInput): Promise<WorkspaceUploadRecord> {
      if (!workspaceExists.get(input.workspaceId)) {
        throw new HttpError(404, 'Workspace not found')
      }

      const now = Date.now()
      const originalName = sanitizeOriginalName(input.originalName)
      const id = randomUUID()
      const storageKey = createStorageKey(input.workspaceId, id, originalName)
      const storagePath = resolveStoragePath(uploadsDir, storageKey)
      const row: WorkspaceUploadRow = {
        id,
        workspace_id: input.workspaceId,
        remote_device_id: input.remoteDeviceId ?? null,
        original_name: originalName,
        mime_type: sanitizeMimeType(input.mimeType),
        size_bytes: input.data.byteLength,
        storage_key: storageKey,
        created_at: now,
      }

      try {
        await mkdir(dirname(storagePath), { recursive: true })
        // Async IO keeps a 100MB write from stalling every PTY/WebSocket on
        // the event loop; `wx` keeps the no-clobber guarantee. The INSERT's
        // WHERE EXISTS guard plus the removeFile cleanup below still cover a
        // workspace deleted while the write was in flight.
        await writeFile(storagePath, input.data, { flag: 'wx' })
      } catch {
        throw new HttpError(500, 'Upload could not be saved')
      }

      try {
        const result = insertUpload.run(
          row.id,
          row.workspace_id,
          row.remote_device_id,
          row.original_name,
          row.mime_type,
          row.size_bytes,
          row.storage_key,
          row.created_at,
          row.workspace_id
        )
        if (result.changes !== 1) {
          removeFile(storagePath)
          throw new HttpError(404, 'Workspace not found')
        }
      } catch (error) {
        removeFile(storagePath)
        if (error instanceof HttpError) throw error
        // Raw driver errors (e.g. "database or disk is full") would otherwise
        // reach the client via the app-level error serializer.
        throw new HttpError(500, 'Upload could not be saved')
      }

      return mapRow(row)
    },

    listUploads(workspaceId: string, limit = 50): WorkspaceUploadRecord[] {
      const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50
      return (listUploads.all(workspaceId, safeLimit) as WorkspaceUploadRow[]).map(mapRow)
    },

    async readUpload(
      workspaceId: string,
      uploadId: string
    ): Promise<{ data: Buffer; record: WorkspaceUploadRecord } | undefined> {
      const row = getUpload.get(workspaceId, uploadId) as WorkspaceUploadRow | undefined
      if (!row) return undefined
      const data = await readRowDataStrict(uploadsDir, row)
      if (!data) return undefined
      return { data, record: mapRow(row) }
    },

    /**
     * Phase one of workspace-upload deletion; call inside the data-mutation
     * transaction. Rows are deleted and blobs renamed to `.deleting-*`
     * tombstones, but nothing is permanently unlinked until `commit()` runs
     * after the transaction commits — so a failed COMMIT can still
     * `rollback()` and restore every blob. Tombstones orphaned by a crash
     * between the phases are reconciled by the startup sweep.
     */
    stageWorkspaceUploadsDelete(workspaceId: string): StagedWorkspaceUploadsDelete {
      const rows = listUploadsForDelete.all(workspaceId) as WorkspaceUploadRow[]
      const staged = stageFilesForDelete(uploadsDir, rows)
      try {
        deleteWorkspaceRows.run(workspaceId)
      } catch (error) {
        restoreStagedFiles(staged)
        throw error
      }
      return {
        commit: () => {
          for (const item of staged) removeFile(item.stagedPath)
          pruneWorkspaceUploadDir(uploadsDir, workspaceId)
        },
        rollback: () => restoreStagedFiles(staged),
      }
    },
  }
}
