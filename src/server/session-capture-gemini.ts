import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'
import { arePathsEqual, expandHomePath } from './platform-path.js'

const GEMINI_SESSION_FILE = /^session-.*\.json$/i

const getDefaultGeminiHome = () => process.env.HIVE_GEMINI_HOME ?? join(homedir(), '.gemini')

export const getGeminiHome = (pattern?: string, platform: NodeJS.Platform = process.platform) => {
  if (!pattern) return getDefaultGeminiHome()
  const normalized = platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern
  const sessionDirectory =
    platform === 'win32' ? /\/tmp\/[^/]+\/chats(?=\/|$)/giu : /\/tmp\/[^/]+\/chats(?=\/|$)/gu
  const markerIndex = [...normalized.matchAll(sessionDirectory)].at(-1)?.index
  if (markerIndex === undefined) return getDefaultGeminiHome()
  const rawRoot = pattern.slice(0, markerIndex).replace(/[\\/]+$/u, '')
  const root = expandHomePath(rawRoot)
  if (arePathsEqual(root, join(homedir(), '.gemini'), platform)) return getDefaultGeminiHome()
  return root || getDefaultGeminiHome()
}

const readProjectRoot = (projectDir: string) => {
  try {
    return readFileSync(join(projectDir, '.project_root'), 'utf8').trim()
  } catch {
    return null
  }
}

const parseGeminiSessionId = (filePath: string) => {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object') return null
  return 'sessionId' in parsed && typeof parsed.sessionId === 'string' ? parsed.sessionId : null
}

const listSessionIds = (cwd: string, geminiHome = getDefaultGeminiHome()) => {
  const tmpRoot = join(geminiHome, 'tmp')
  try {
    return readdirSync(tmpRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const projectDir = join(tmpRoot, entry.name)
        const projectRoot = readProjectRoot(projectDir)
        if (projectRoot === null || !arePathsEqual(projectRoot, cwd)) return []
        const chatsDir = join(projectDir, 'chats')
        try {
          return readdirSync(chatsDir, { withFileTypes: true }).flatMap((chat) => {
            if (!chat.isFile() || !GEMINI_SESSION_FILE.test(chat.name)) return []
            try {
              const sessionId = parseGeminiSessionId(join(chatsDir, chat.name))
              return sessionId ? [sessionId] : []
            } catch {
              return []
            }
          })
        } catch {
          return []
        }
      })
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

export const hasGeminiSession = (cwd: string, sessionId: string, pattern?: string) =>
  listSessionIds(cwd, getGeminiHome(pattern)).includes(sessionId)

export const snapshotGeminiSessionIds = (cwd: string, geminiHome = getDefaultGeminiHome()) =>
  new Set(listSessionIds(cwd, geminiHome))

export const captureGeminiSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  geminiHome = getDefaultGeminiHome(),
  signal?: AbortSignal
) => {
  await captureSessionIdWithCoordinator({
    signal,
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, geminiHome),
    onCapture,
    projectKey: join(geminiHome, 'tmp', cwd),
    timeoutMs,
  })
}

export const geminiSessionStoreExists = (geminiHome = getDefaultGeminiHome()) =>
  existsSync(join(geminiHome, 'tmp'))
