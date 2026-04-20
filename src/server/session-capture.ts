import {
  captureClaudeSessionId,
  getClaudeProjectsRoot,
  hasClaudeSessionFile,
  snapshotClaudeSessionIds,
} from './session-capture-claude.js'

export type SessionIdCaptureConfig =
  | { source: 'claude_project_jsonl_dir'; pattern: string }
  | { source: 'stdout_regex'; pattern: string }
  | { source: 'banner_parse'; pattern?: string }

export interface SessionCaptureSnapshot {
  knownSessionIds: Set<string>
  projectsRoot?: string
}

const hasSource = (value: unknown): value is { source: string } =>
  Boolean(value && typeof value === 'object' && 'source' in value)

export const parseSessionIdCapture = (value: unknown): SessionIdCaptureConfig | null => {
  if (!hasSource(value)) return null
  const pattern =
    'pattern' in value && (typeof value.pattern === 'string' || value.pattern === undefined)
      ? value.pattern
      : undefined
  if (value.source === 'claude_project_jsonl_dir' || value.source === 'stdout_regex') {
    return typeof pattern === 'string' ? { pattern, source: value.source } : null
  }
  if (value.source === 'banner_parse') {
    return pattern === undefined ? { source: value.source } : { pattern, source: value.source }
  }
  return null
}

export const snapshotSessionIdsForCapture = (
  cwd: string,
  capture: SessionIdCaptureConfig | null | undefined
) => {
  if (!capture) return undefined
  if (capture.source === 'claude_project_jsonl_dir') {
    const projectsRoot = getClaudeProjectsRoot(capture.pattern)
    return { knownSessionIds: snapshotClaudeSessionIds(cwd, projectsRoot), projectsRoot }
  }
  return undefined
}

export const getSessionCaptureEnvironment = (
  snapshot: SessionCaptureSnapshot | undefined
): Record<string, string> =>
  snapshot?.projectsRoot ? { HIVE_CLAUDE_PROJECTS_DIR: snapshot.projectsRoot } : {}

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
      snapshot.projectsRoot
    )
  }
}

export const doesCapturedSessionExist = (
  cwd: string,
  capture: SessionIdCaptureConfig,
  sessionId: string
) => {
  if (capture.source === 'claude_project_jsonl_dir') {
    return hasClaudeSessionFile(cwd, sessionId, capture.pattern)
  }
  return false
}
