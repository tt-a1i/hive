import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'

import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'
import { arePathsEqual, expandHomePath, indexOfPathMarker } from './platform-path.js'
import type { SessionCaptureSnapshot } from './session-capture.js'

const CODEX_SESSION_FILE = /^rollout-.*\.jsonl$/i
const CODEX_SESSIONS_MARKER = '/sessions/'
const CODEX_HEADER_READ_CHUNK_BYTES = 4096
const CODEX_HEADER_MAX_BYTES = 64 * 1024
// Startup input can follow large native instructions; never scan an entire history.
const CODEX_STARTUP_MAX_BYTES = 1024 * 1024

const getDefaultCodexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex')

export const getCodexHome = (
  pattern?: string,
  platform: NodeJS.Platform = process.platform,
  cwd?: string
) => {
  const paths = platform === 'win32' ? win32 : posix
  const fromLaunchDirectory = (root: string) =>
    cwd && !paths.isAbsolute(root) ? paths.resolve(cwd, root) : root
  if (!pattern) return fromLaunchDirectory(getDefaultCodexHome())
  const markerIndex = indexOfPathMarker(pattern, CODEX_SESSIONS_MARKER, platform)
  if (markerIndex === -1) return fromLaunchDirectory(getDefaultCodexHome())
  const rawRoot = pattern.slice(0, markerIndex).replace(/[\\/]+$/u, '')
  const root = expandHomePath(rawRoot)
  if (arePathsEqual(root, join(homedir(), '.codex'), platform))
    return fromLaunchDirectory(getDefaultCodexHome())
  return fromLaunchDirectory(root || getDefaultCodexHome())
}

const walkSessionFiles = (dir: string, onUnreadable?: () => void): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walkSessionFiles(path, onUnreadable)
      return entry.isFile() && CODEX_SESSION_FILE.test(entry.name) ? [path] : []
    })
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      onUnreadable?.()
    return []
  }
}

export const readCodexSessionFirstLine = (
  filePath: string,
  maxBytes = CODEX_HEADER_MAX_BYTES
): string | null => {
  const fd = openSync(filePath, 'r')
  try {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let position = 0
    let reachedLineEnd = false

    while (totalBytes < maxBytes) {
      const bytesToRead = Math.min(CODEX_HEADER_READ_CHUNK_BYTES, maxBytes - totalBytes)
      const buffer = Buffer.allocUnsafe(bytesToRead)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position)
      if (bytesRead === 0) {
        reachedLineEnd = true
        break
      }

      const slice = buffer.subarray(0, bytesRead)
      const newlineIndex = slice.indexOf(0x0a)
      if (newlineIndex >= 0) {
        chunks.push(slice.subarray(0, newlineIndex))
        reachedLineEnd = true
        break
      }

      chunks.push(slice)
      totalBytes += bytesRead
      position += bytesRead
    }

    if (!reachedLineEnd) return null
    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
  } finally {
    closeSync(fd)
  }
}

const parseCodexSession = (filePath: string) => {
  const firstLine = readCodexSessionFirstLine(filePath) ?? ''
  const parsed = JSON.parse(firstLine) as unknown
  if (!parsed || typeof parsed !== 'object' || !('payload' in parsed)) return null
  const payload = parsed.payload
  if (!payload || typeof payload !== 'object') return null
  const id = 'id' in payload && typeof payload.id === 'string' ? payload.id : null
  const cwd = 'cwd' in payload && typeof payload.cwd === 'string' ? payload.cwd : null
  return id && cwd ? { cwd, id } : null
}

const getCodexStartupOwnership = (
  filePath: string,
  contentIncludes: string | readonly string[]
): boolean | undefined => {
  const needles = typeof contentIncludes === 'string' ? [contentIncludes] : contentIncludes
  const fd = openSync(filePath, 'r')
  try {
    let pending = Buffer.alloc(0)
    let position = 0
    while (position < CODEX_STARTUP_MAX_BYTES) {
      const buffer = Buffer.allocUnsafe(
        Math.min(CODEX_HEADER_READ_CHUNK_BYTES, CODEX_STARTUP_MAX_BYTES - position)
      )
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position)
      if (!bytesRead) return undefined
      position += bytesRead
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)])
      let newline = pending.indexOf(0x0a)
      while (newline >= 0) {
        const record = JSON.parse(pending.subarray(0, newline).toString('utf8'))
        pending = pending.subarray(newline + 1)
        if (record?.type === 'response_item') {
          const payload = record.payload
          if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string')
            return undefined
          // Once the model responds, a later quoted startup cannot establish ownership.
          if (payload.role === 'assistant' || payload.type !== 'message') return false
          if (payload.role === 'user' && Array.isArray(payload.content)) {
            const text = payload.content
              .filter(
                (item: { type?: string; text?: unknown } | null) =>
                  item?.type === 'input_text' && typeof item.text === 'string'
              )
              .map((item: { text: string }) => item.text)
              .join('')
            if (text.startsWith('<hive-message kind="startup">')) {
              // Only the complete generated header establishes ownership. Old
              // multiline metadata cannot be distinguished reliably from fields.
              const header = text.match(
                /^<hive-message kind="startup">\r?\n\r?\n(You are [^\r\n]+)\r?\nCurrent workspace: [^\r\n]*\r?\nProject path: [^\r\n]*\r?\n(?:(Hive session binding: [^\r\n]+)\r?\n)?\r?\nYour role: /u
              )
              if (!header) return undefined
              // A recreated member can keep its name, but must not inherit the old ID.
              return needles.includes(header[2] ?? header[1] ?? '')
            }
          }
        }
        newline = pending.indexOf(0x0a)
      }
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

const listSessionIds = (
  cwd: string,
  codexHome = getDefaultCodexHome(),
  platform: NodeJS.Platform = process.platform
) => {
  const sessionsRoot = join(codexHome, 'sessions')
  return walkSessionFiles(sessionsRoot)
    .flatMap((filePath) => {
      try {
        const session = parseCodexSession(filePath)
        return session && arePathsEqual(session.cwd, cwd, platform) ? [session.id] : []
      } catch {
        return []
      }
    })
    .sort((left, right) => left.localeCompare(right))
}

const fileNameMatchesSessionId = (filePath: string, sessionId: string) =>
  basename(filePath).endsWith(`-${sessionId}.jsonl`)

export const getCodexSessionExistence = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  platform: NodeJS.Platform = process.platform,
  codexHome: string = getCodexHome(pattern, platform, cwd),
  discriminator?: SessionCaptureSnapshot['discriminator']
) => {
  const sessionsRoot = join(codexHome, 'sessions')
  let foundUnverifiableMatchingFile = false
  const sessionFiles = walkSessionFiles(sessionsRoot, () => {
    foundUnverifiableMatchingFile = true
  })
  // Normal Codex filenames locate the target directly; retain metadata lookup
  // for historical files with a nonstandard filename.
  const matchingFiles = sessionFiles.filter((path) => fileNameMatchesSessionId(path, sessionId))
  const otherFiles = sessionFiles.filter((path) => !fileNameMatchesSessionId(path, sessionId))
  for (const filePath of [...matchingFiles, ...otherFiles]) {
    try {
      const session = parseCodexSession(filePath)
      if (session?.id === sessionId) {
        if (!arePathsEqual(session.cwd, cwd, platform)) return false
        foundUnverifiableMatchingFile = true
        return discriminator?.contentIncludes
          ? getCodexStartupOwnership(filePath, discriminator.contentIncludes)
          : true
      }
      if (!session && fileNameMatchesSessionId(filePath, sessionId)) {
        foundUnverifiableMatchingFile = true
      }
    } catch {
      if (fileNameMatchesSessionId(filePath, sessionId)) foundUnverifiableMatchingFile = true
    }
  }
  return foundUnverifiableMatchingFile ? undefined : false
}

export const hasCodexSession = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  platform: NodeJS.Platform = process.platform,
  codexHome: string = getCodexHome(pattern, platform, cwd),
  discriminator?: SessionCaptureSnapshot['discriminator']
) => getCodexSessionExistence(cwd, sessionId, pattern, platform, codexHome, discriminator) ?? false

export const snapshotCodexSessionIds = (
  cwd: string,
  codexHome = getDefaultCodexHome(),
  platform: NodeJS.Platform = process.platform
) => new Set(listSessionIds(cwd, codexHome, platform))

export const captureCodexSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  codexHome = getDefaultCodexHome(),
  discriminator?: SessionCaptureSnapshot['discriminator']
) => {
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, codexHome),
    onCapture,
    projectKey: join(codexHome, 'sessions', cwd),
    timeoutMs,
    ...(discriminator?.contentIncludes
      ? {
          matchesSessionId: (sessionId: string) =>
            getCodexSessionExistence(
              cwd,
              sessionId,
              undefined,
              process.platform,
              codexHome,
              discriminator
            ) === true,
        }
      : {}),
  })
}

export const codexSessionStoreExists = (codexHome = getDefaultCodexHome()) =>
  existsSync(join(codexHome, 'sessions'))
