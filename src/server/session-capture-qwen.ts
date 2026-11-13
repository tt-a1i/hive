import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'
import { arePathsEqual, expandHomePath, indexOfPathMarker } from './platform-path.js'

const QWEN_SESSION_FILE = /\.json$/i
const QWEN_SESSIONS_MARKER = '/sessions/'
const QWEN_HEADER_READ_CHUNK_BYTES = 4096
const QWEN_HEADER_MAX_BYTES = 256 * 1024

const getDefaultQwenHome = () => process.env.HIVE_QWEN_HOME ?? join(homedir(), '.qwen')

export const getQwenHome = (pattern?: string, platform: NodeJS.Platform = process.platform) => {
  if (!pattern) return getDefaultQwenHome()
  const markerIndex = indexOfPathMarker(pattern, QWEN_SESSIONS_MARKER, platform)
  if (markerIndex === -1) return getDefaultQwenHome()
  const rawRoot = pattern.slice(0, markerIndex).replace(/[\\/]+$/u, '')
  const root = expandHomePath(rawRoot)
  if (arePathsEqual(root, join(homedir(), '.qwen'), platform)) return getDefaultQwenHome()
  return root || getDefaultQwenHome()
}

const walkSessionFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walkSessionFiles(path)
      return entry.isFile() && QWEN_SESSION_FILE.test(entry.name) ? [path] : []
    })
  } catch {
    return []
  }
}

const readQwenSessionHeader = (filePath: string, maxBytes = QWEN_HEADER_MAX_BYTES) => {
  const fd = openSync(filePath, 'r')
  try {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let position = 0

    while (totalBytes < maxBytes) {
      const bytesToRead = Math.min(QWEN_HEADER_READ_CHUNK_BYTES, maxBytes - totalBytes)
      const buffer = Buffer.allocUnsafe(bytesToRead)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position)
      if (bytesRead === 0) break
      const slice = buffer.subarray(0, bytesRead)
      chunks.push(slice)
      totalBytes += bytesRead
      position += bytesRead
    }

    return Buffer.concat(chunks).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const readJsonStringField = (input: string, key: string): string | null => {
  const regex = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 'u')
  const raw = regex.exec(input)?.[1]
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

const parseQwenSession = (filePath: string) => {
  const header = readQwenSessionHeader(filePath)
  const id = readJsonStringField(header, 'sessionId')
  const cwd = readJsonStringField(header, 'projectRoot')
  return id && cwd ? { cwd, id } : null
}

const listSessionIds = (
  cwd: string,
  qwenHome = getDefaultQwenHome(),
  platform: NodeJS.Platform = process.platform
) => {
  const sessionsRoot = join(qwenHome, 'sessions')
  return walkSessionFiles(sessionsRoot)
    .flatMap((filePath) => {
      try {
        const session = parseQwenSession(filePath)
        return session && arePathsEqual(session.cwd, cwd, platform) ? [session.id] : []
      } catch {
        return []
      }
    })
    .sort((left, right) => left.localeCompare(right))
}

export const hasQwenSession = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  platform: NodeJS.Platform = process.platform,
  qwenHome: string = getQwenHome(pattern, platform)
) => listSessionIds(cwd, qwenHome, platform).includes(sessionId)

export const snapshotQwenSessionIds = (
  cwd: string,
  qwenHome = getDefaultQwenHome(),
  platform: NodeJS.Platform = process.platform
) => new Set(listSessionIds(cwd, qwenHome, platform))

export const captureQwenSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  qwenHome = getDefaultQwenHome(),
  signal?: AbortSignal
) => {
  await captureSessionIdWithCoordinator({
    signal,
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, qwenHome),
    onCapture,
    projectKey: join(qwenHome, 'sessions', cwd),
    timeoutMs,
  })
}

export const qwenSessionStoreExists = (qwenHome = getDefaultQwenHome()) =>
  existsSync(join(qwenHome, 'sessions'))
