import { CLAUDE_DEFAULT_YOLO_ARGS } from './claude-command-defaults.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

export interface BuiltinCommandPresetDefaults {
  id: string
  displayName: string
  command: string
  resumeArgsTemplate: string | null
  sessionIdCapture: SessionIdCaptureConfig | null
  yoloArgsTemplate: string[] | null
}

const CODEX_DEFAULT_YOLO_ARGS = ['--dangerously-bypass-approvals-and-sandbox']
const OPENCODE_DEFAULT_YOLO_ARGS: string[] = []
const GEMINI_DEFAULT_YOLO_ARGS = ['--yolo']

export const BUILTIN_COMMAND_PRESETS: BuiltinCommandPresetDefaults[] = [
  {
    command: 'claude',
    displayName: 'Claude Code (CC)',
    id: 'claude',
    resumeArgsTemplate: '--resume {session_id}',
    sessionIdCapture: {
      pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
      source: 'claude_project_jsonl_dir',
    },
    yoloArgsTemplate: CLAUDE_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'codex',
    displayName: 'Codex',
    id: 'codex',
    resumeArgsTemplate: 'resume {session_id}',
    sessionIdCapture: {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir',
    },
    yoloArgsTemplate: CODEX_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'opencode',
    displayName: 'OpenCode',
    id: 'opencode',
    resumeArgsTemplate: '--session {session_id}',
    sessionIdCapture: {
      pattern: '~/.local/share/opencode/opencode.db',
      source: 'opencode_session_db',
    },
    yoloArgsTemplate: OPENCODE_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'gemini',
    displayName: 'Gemini',
    id: 'gemini',
    resumeArgsTemplate: '--resume {session_id}',
    sessionIdCapture: {
      pattern: '~/.gemini/tmp/*/chats/*.json',
      source: 'gemini_session_json_dir',
    },
    yoloArgsTemplate: GEMINI_DEFAULT_YOLO_ARGS,
  },
]

export const getBuiltinCommandPreset = (id: string) =>
  BUILTIN_COMMAND_PRESETS.find((preset) => preset.id === id)
