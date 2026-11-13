import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { expandHomePath } from '../../src/server/platform-path.js'
import { getClaudeProjectsRoot } from '../../src/server/session-capture-claude.js'
import { getCodexHome } from '../../src/server/session-capture-codex.js'
import { getGeminiHome } from '../../src/server/session-capture-gemini.js'
import { getOpenCodeDbPath } from '../../src/server/session-capture-opencode.js'

describe('session capture home path expansion', () => {
  test('expands Windows-style home prefixes', () => {
    expect(expandHomePath('~\\AppData\\Local')).toBe(join(homedir(), 'AppData', 'Local'))
  })

  test('recognizes default Claude project roots with backslashes', () => {
    expect(getClaudeProjectsRoot('~\\.claude\\projects\\{encoded_cwd}\\*.jsonl', 'win32')).toBe(
      getClaudeProjectsRoot('~/.claude/projects/{encoded_cwd}/*.jsonl', 'win32')
    )
  })

  test('recognizes default Gemini homes with backslashes', () => {
    expect(getGeminiHome('~\\.gemini\\tmp\\*\\chats\\*.json', 'win32')).toBe(
      getGeminiHome('~/.gemini/tmp/*/chats/*.json', 'win32')
    )
  })

  test('recognizes Windows Gemini tmp marker casing case-insensitively', () => {
    expect(getGeminiHome('D:\\GeminiData\\TMP\\*\\chats\\*.json', 'win32')).toBe('D:\\GeminiData')
  })

  test.each([
    ['/tmp/hive-capture/gemini/tmp/*/chats/*.json', '/tmp/hive-capture/gemini', 'linux'],
    [
      '~/custom/tmp/nested/gemini/tmp/project/chats/*.json',
      join(homedir(), 'custom/tmp/nested/gemini'),
      'linux',
    ],
    [
      'D:\\tmp\\capture\\GeminiData\\TMP\\*\\CHATS\\*.json',
      'D:\\tmp\\capture\\GeminiData',
      'win32',
    ],
  ] as const)('uses the Gemini chat suffix in %s', (pattern, root, platform) => {
    expect(getGeminiHome(pattern, platform)).toBe(root)
  })

  test('ignores unrelated tmp directories and retains the default root', () => {
    expect(getGeminiHome('/storage/tmp/archives/*.json', 'linux')).toBe(getGeminiHome())
    expect(getGeminiHome()).toBe(getGeminiHome('~/.gemini/tmp/*/chats/*.json'))
  })

  test('expands custom Codex homes with backslashes', () => {
    expect(getCodexHome('~\\custom\\codex\\sessions\\**\\*.jsonl', 'win32')).toBe(
      join(homedir(), 'custom', 'codex')
    )
  })

  test('recognizes Windows Codex sessions marker casing case-insensitively', () => {
    expect(getCodexHome('C:\\CodexData\\Sessions\\**\\*.jsonl', 'win32')).toBe('C:\\CodexData')
  })

  test('expands custom OpenCode database paths with backslashes', () => {
    expect(getOpenCodeDbPath('~\\AppData\\Local\\opencode\\opencode.db', 'win32')).toBe(
      join(homedir(), 'AppData', 'Local', 'opencode', 'opencode.db')
    )
  })
})
