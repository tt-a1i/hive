import {
  captureClaudeSessionId,
  hasClaudeSessionFile,
  snapshotClaudeSessionIds,
} from './session-capture-claude.js'

export type SessionIdCaptureConfig =
  | { source: 'claude_project_jsonl_dir'; pattern: string }
  | { source: 'stdout_regex'; pattern: string }
  | { source: 'banner_parse'; pattern?: string }

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
    return snapshotClaudeSessionIds(cwd)
  }
  return undefined
}

export const captureSessionIdForCapture = async (
  cwd: string,
  capture: SessionIdCaptureConfig,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100
) => {
  if (capture.source === 'claude_project_jsonl_dir') {
    await captureClaudeSessionId(cwd, knownSessionIds, onCapture, timeoutMs, intervalMs)
  }
}

export const doesCapturedSessionExist = (
  cwd: string,
  capture: SessionIdCaptureConfig,
  sessionId: string
) => {
  if (capture.source === 'claude_project_jsonl_dir') {
    return hasClaudeSessionFile(cwd, sessionId)
  }
  return false
}
