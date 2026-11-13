import { CLAUDE_DEFAULT_YOLO_ARGS } from './claude-command-defaults.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

export const BUILTIN_COMMAND_PRESET_IDS = [
  'claude',
  'codex',
  'opencode',
  'gemini',
  'hermes',
  'qwen',
  'pi',
  'agy',
  'cursor',
  'grok',
  'kimi',
] as const

export type BuiltinCommandPresetId = (typeof BUILTIN_COMMAND_PRESET_IDS)[number]

export interface BuiltinCommandPresetDefaults {
  id: BuiltinCommandPresetId
  displayName: string
  command: string
  resumeArgsTemplate: string | null
  sessionIdCapture: SessionIdCaptureConfig | null
  yoloArgsTemplate: string[] | null
}

const CODEX_DEFAULT_YOLO_ARGS = ['--dangerously-bypass-approvals-and-sandbox']
const OPENCODE_DEFAULT_YOLO_ARGS: string[] = []
const GEMINI_DEFAULT_YOLO_ARGS = ['--yolo']
const HERMES_DEFAULT_YOLO_ARGS = ['--yolo']
const QWEN_DEFAULT_YOLO_ARGS = ['--approval-mode', 'yolo']
const PI_DEFAULT_YOLO_ARGS = ['--approve']
const AGY_DEFAULT_YOLO_ARGS = ['--dangerously-skip-permissions']
const CURSOR_DEFAULT_YOLO_ARGS = ['--force']
const GROK_DEFAULT_YOLO_ARGS = ['--always-approve']

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
  {
    command: 'hermes',
    displayName: 'Hermes',
    id: 'hermes',
    resumeArgsTemplate: '--resume {session_id}',
    sessionIdCapture: {
      pattern: String.raw`Session:\s*([A-Za-z0-9_-]+)`,
      source: 'stdout_regex',
    },
    yoloArgsTemplate: HERMES_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'qwen',
    displayName: 'Qwen Code',
    id: 'qwen',
    resumeArgsTemplate: '--resume {session_id}',
    sessionIdCapture: {
      pattern: '~/.qwen/sessions/**/*.json',
      source: 'qwen_session_json_dir',
    },
    yoloArgsTemplate: QWEN_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'pi',
    displayName: 'Pi',
    id: 'pi',
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: PI_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'agy',
    displayName: 'Antigravity CLI',
    id: 'agy',
    resumeArgsTemplate: '--conversation {session_id}',
    sessionIdCapture: {
      pattern: String.raw`(?:^|\s)(?:\S*[\\/])?agy(?:\.(?:cmd|exe))?\s+--conversation\s+([0-9a-fA-F-]{36})\b`,
      source: 'stdout_regex',
    },
    yoloArgsTemplate: AGY_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'cursor-agent',
    displayName: 'Cursor CLI',
    id: 'cursor',
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: CURSOR_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'grok',
    displayName: 'Grok Build',
    id: 'grok',
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: GROK_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'kimi',
    displayName: 'Kimi Code',
    id: 'kimi',
    resumeArgsTemplate: '--session {session_id}',
    sessionIdCapture: null,
    yoloArgsTemplate: ['--auto'],
  },
]

export const getBuiltinCommandPreset = (id: string) =>
  BUILTIN_COMMAND_PRESETS.find((preset) => preset.id === id)

export const getBuiltinCommandPresetByCommand = (command: string) =>
  BUILTIN_COMMAND_PRESETS.find((preset) => preset.command === command)

export const BUILTIN_COMMAND_PRESET_CLI_LIST = BUILTIN_COMMAND_PRESET_IDS.join('|')

export const BUILTIN_INTERACTIVE_COMMANDS = new Set(
  BUILTIN_COMMAND_PRESETS.flatMap((preset) => [preset.id, preset.command])
)
