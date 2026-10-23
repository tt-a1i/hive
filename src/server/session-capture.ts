import {
  captureClaudeSessionId,
  getClaudeProjectsRoot,
  hasClaudeSessionFile,
  snapshotClaudeSessionIds,
} from './session-capture-claude.js'
import {
  captureCodexSessionId,
  getCodexHome,
  getCodexSessionExistence,
  snapshotCodexSessionIds,
} from './session-capture-codex.js'
import {
  captureGeminiSessionId,
  getGeminiHome,
  hasGeminiSession,
  snapshotGeminiSessionIds,
} from './session-capture-gemini.js'
import {
  captureOpenCodeSessionId,
  getOpenCodeDbPath,
  hasOpenCodeSession,
  snapshotOpenCodeSessionIds,
} from './session-capture-opencode.js'
import {
  captureQwenSessionId,
  getQwenHome,
  hasQwenSession,
  snapshotQwenSessionIds,
} from './session-capture-qwen.js'

export type SessionIdCaptureConfig =
  | { source: 'claude_project_jsonl_dir'; pattern: string }
  | { source: 'codex_session_jsonl_dir'; pattern: string }
  | { source: 'gemini_session_json_dir'; pattern: string }
  | { source: 'opencode_session_db'; pattern: string }
  | { source: 'qwen_session_json_dir'; pattern: string }
  | { source: 'stdout_regex'; pattern: string }
  | { source: 'banner_parse'; pattern?: string }

export interface SessionCaptureSnapshot {
  discriminator?: { contentIncludes: string | readonly string[] }
  getOutput?: () => string | null
  knownSessionIds: Set<string>
  env?: Record<string, string>
  root?: string
}

const hasSource = (value: unknown): value is { source: string } =>
  Boolean(value && typeof value === 'object' && 'source' in value)

export const parseSessionIdCapture = (value: unknown): SessionIdCaptureConfig | null => {
  if (!hasSource(value)) return null
  const pattern =
    'pattern' in value && (typeof value.pattern === 'string' || value.pattern === undefined)
      ? value.pattern
      : undefined
  if (
    value.source === 'claude_project_jsonl_dir' ||
    value.source === 'codex_session_jsonl_dir' ||
    value.source === 'gemini_session_json_dir' ||
    value.source === 'opencode_session_db' ||
    value.source === 'qwen_session_json_dir' ||
    value.source === 'stdout_regex'
  ) {
    return typeof pattern === 'string' ? { pattern, source: value.source } : null
  }
  if (value.source === 'banner_parse') {
    return pattern === undefined ? { source: value.source } : { pattern, source: value.source }
  }
  return null
}

export const snapshotSessionIdsForCapture = (
  cwd: string,
  capture: SessionIdCaptureConfig | null | undefined,
  discriminator?: SessionCaptureSnapshot['discriminator']
) => {
  if (!capture) return undefined
  if (capture.source === 'claude_project_jsonl_dir') {
    const projectsRoot = getClaudeProjectsRoot(capture.pattern)
    return {
      env: { HIVE_CLAUDE_PROJECTS_DIR: projectsRoot },
      knownSessionIds: snapshotClaudeSessionIds(cwd, projectsRoot),
      root: projectsRoot,
      ...(discriminator ? { discriminator } : {}),
    }
  }
  if (capture.source === 'codex_session_jsonl_dir') {
    const codexHome = getCodexHome(capture.pattern, process.platform, cwd)
    return {
      env: { CODEX_HOME: codexHome },
      knownSessionIds: snapshotCodexSessionIds(cwd, codexHome),
      root: codexHome,
      ...(discriminator ? { discriminator } : {}),
    }
  }
  if (capture.source === 'gemini_session_json_dir') {
    const geminiHome = getGeminiHome(capture.pattern)
    return {
      env: { HIVE_GEMINI_HOME: geminiHome },
      knownSessionIds: snapshotGeminiSessionIds(cwd, geminiHome),
      root: geminiHome,
    }
  }
  if (capture.source === 'opencode_session_db') {
    const dbPath = getOpenCodeDbPath(capture.pattern)
    return {
      env: { HIVE_OPENCODE_DB_PATH: dbPath },
      knownSessionIds: snapshotOpenCodeSessionIds(cwd, dbPath),
      root: dbPath,
    }
  }
  if (capture.source === 'qwen_session_json_dir') {
    const qwenHome = getQwenHome(capture.pattern)
    return {
      env: { HIVE_QWEN_HOME: qwenHome },
      knownSessionIds: snapshotQwenSessionIds(cwd, qwenHome),
      root: qwenHome,
    }
  }
  if (capture.source === 'stdout_regex') {
    return {
      knownSessionIds: new Set<string>(),
    }
  }
  return undefined
}

export const getSessionCaptureEnvironment = (
  snapshot: SessionCaptureSnapshot | undefined
): Record<string, string> => snapshot?.env ?? {}

export const captureSessionIdForCapture = async (
  cwd: string,
  capture: SessionIdCaptureConfig,
  snapshot: SessionCaptureSnapshot,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100
) => {
  if (capture.source === 'claude_project_jsonl_dir') {
    await captureClaudeSessionId(
      cwd,
      snapshot.knownSessionIds,
      onCapture,
      timeoutMs,
      intervalMs,
      snapshot.root,
      snapshot.discriminator
    )
  }
  if (capture.source === 'codex_session_jsonl_dir') {
    await captureCodexSessionId(
      cwd,
      snapshot.knownSessionIds,
      onCapture,
      timeoutMs,
      intervalMs,
      snapshot.root,
      snapshot.discriminator
    )
  }
  if (capture.source === 'gemini_session_json_dir') {
    await captureGeminiSessionId(
      cwd,
      snapshot.knownSessionIds,
      onCapture,
      timeoutMs,
      intervalMs,
      snapshot.root
    )
  }
  if (capture.source === 'opencode_session_db') {
    await captureOpenCodeSessionId(
      cwd,
      snapshot.knownSessionIds,
      onCapture,
      timeoutMs,
      intervalMs,
      snapshot.root
    )
  }
  if (capture.source === 'qwen_session_json_dir') {
    await captureQwenSessionId(
      cwd,
      snapshot.knownSessionIds,
      onCapture,
      timeoutMs,
      intervalMs,
      snapshot.root
    )
  }
  if (capture.source === 'stdout_regex') {
    await captureStdoutRegexSessionId(
      capture.pattern,
      snapshot.getOutput,
      snapshot.knownSessionIds,
      onCapture,
      timeoutMs,
      intervalMs
    )
  }
}

export const getCapturedSessionExistence = (
  cwd: string,
  capture: SessionIdCaptureConfig,
  sessionId: string,
  discriminator?: SessionCaptureSnapshot['discriminator']
): boolean | undefined => {
  if (capture.source === 'claude_project_jsonl_dir') {
    return hasClaudeSessionFile(cwd, sessionId, capture.pattern, discriminator)
  }
  if (capture.source === 'codex_session_jsonl_dir') {
    return getCodexSessionExistence(
      cwd,
      sessionId,
      capture.pattern,
      process.platform,
      undefined,
      discriminator
    )
  }
  if (capture.source === 'gemini_session_json_dir') {
    return hasGeminiSession(cwd, sessionId, capture.pattern)
  }
  if (capture.source === 'opencode_session_db') {
    return hasOpenCodeSession(cwd, sessionId, capture.pattern)
  }
  if (capture.source === 'qwen_session_json_dir') {
    return hasQwenSession(cwd, sessionId, capture.pattern)
  }
  return undefined
}

export const doesCapturedSessionExist = (
  cwd: string,
  capture: SessionIdCaptureConfig,
  sessionId: string,
  discriminator?: SessionCaptureSnapshot['discriminator']
) => getCapturedSessionExistence(cwd, capture, sessionId, discriminator) ?? false

const compileCaptureRegex = (pattern: string) => {
  try {
    return new RegExp(pattern, 'u')
  } catch {
    return null
  }
}

export const captureStdoutRegexSessionId = async (
  pattern: string,
  getOutput: (() => string | null) | undefined,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100
) => {
  const regex = compileCaptureRegex(pattern)
  if (!regex || !getOutput) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const output = getOutput()
    const match = output ? regex.exec(output) : null
    const sessionId = match?.[1]
    if (sessionId && !knownSessionIds.has(sessionId)) {
      onCapture(sessionId)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
