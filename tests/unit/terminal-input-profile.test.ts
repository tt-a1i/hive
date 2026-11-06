import { describe, expect, test } from 'vitest'

import { resolveTerminalInputProfile } from '../../src/server/terminal-input-profile.js'

describe('resolveTerminalInputProfile — cross-platform command normalization', () => {
  test('returns "default" when no config is provided', () => {
    expect(resolveTerminalInputProfile(undefined)).toBe('default')
  })

  test('opencode preset id takes precedence over interactiveCommand', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: 'cmd.exe',
        commandPresetId: 'opencode',
        interactiveCommand: 'cmd.exe',
      })
    ).toBe('opencode')
  })

  test('detects opencode from a bare interactiveCommand', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: 'opencode',
        interactiveCommand: 'opencode',
      })
    ).toBe('opencode')
  })

  test('detects opencode from a Windows absolute path with .cmd suffix', () => {
    // Previously `node:path`'s `basename` was used unconditionally; on
    // macOS test runners it does not treat backslashes as separators and
    // returns the entire string, so this case would fall through to
    // 'default'. Same risk on production Windows runners if the path
    // contains forward slashes mixed in.
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: 'cmd.exe',
        interactiveCommand: 'C:\\Program Files\\nodejs\\opencode.cmd',
      })
    ).toBe('opencode')
  })

  test('detects opencode from a POSIX absolute path', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: '/bin/sh',
        interactiveCommand: '/usr/local/bin/opencode',
      })
    ).toBe('opencode')
  })

  test('detects opencode from a Windows path with mixed slashes and case-variant suffix', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: 'cmd.exe',
        interactiveCommand: 'C:/Users/me/opencode.CMD',
      })
    ).toBe('opencode')
  })

  test('detects claude from a Windows absolute path with .cmd suffix', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: 'claude',
        interactiveCommand: 'C:\\Program Files\\nodejs\\claude.cmd',
      })
    ).toBe('claude')
  })

  test('falls back to command when interactiveCommand is null', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: '/usr/local/bin/opencode',
        interactiveCommand: null,
      })
    ).toBe('opencode')
  })

  test('detects codex from a stale Windows node npm entrypoint', () => {
    expect(
      resolveTerminalInputProfile({
        args: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'],
        command: 'C:\\Program Files\\nodejs\\node.exe',
        commandPresetId: null,
        interactiveCommand: 'C:\\Program Files\\nodejs\\node.exe',
      })
    ).toBe('codex')
  })

  test('detects codex from session capture metadata', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: 'C:\\Program Files\\nodejs\\node.exe',
        commandPresetId: null,
        interactiveCommand: 'C:\\Program Files\\nodejs\\node.exe',
        sessionIdCapture: {
          pattern: '~/.codex/sessions/**/*.jsonl',
          source: 'codex_session_jsonl_dir',
        },
      })
    ).toBe('codex')
  })
})

describe('resolveTerminalInputProfile — legacy and wrapped launch shapes', () => {
  test('detects codex from a legacy cmd.exe-wrapped startup command with flags', () => {
    // Launch configs persisted before interactiveCommand existed only carry
    // the shell spawn shape; Windows codex orchestrators saved by old Hive
    // versions degrade to arrow-key wheel input unless this resolves.
    expect(
      resolveTerminalInputProfile({
        args: ['/d', '/s', '/c', 'codex --dangerously-bypass-approvals-and-sandbox'],
        command: 'cmd.exe',
        commandPresetId: null,
        interactiveCommand: null,
      })
    ).toBe('codex')
  })

  test('detects codex from a POSIX shell-wrapped startup command', () => {
    expect(
      resolveTerminalInputProfile({
        args: ['-lic', 'codex resume 0123'],
        command: '/bin/zsh',
        commandPresetId: null,
        interactiveCommand: null,
      })
    ).toBe('codex')
  })

  test('detects opencode from a quoted Windows path inside a shell-wrapped command', () => {
    expect(
      resolveTerminalInputProfile({
        args: ['/d', '/s', '/c', '"C:\\Program Files\\nodejs\\opencode.cmd" --port 1234'],
        command: 'cmd.exe',
        commandPresetId: null,
        interactiveCommand: null,
      })
    ).toBe('opencode')
  })

  test('detects codex behind npx in spawn args', () => {
    expect(
      resolveTerminalInputProfile({
        args: ['-y', '@openai/codex', '--yolo'],
        command: 'npx',
        commandPresetId: null,
        interactiveCommand: null,
      })
    ).toBe('codex')
  })

  test('detects codex behind npx inside an interactive command line', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: 'cmd.exe',
        commandPresetId: null,
        interactiveCommand: 'npx codex',
      })
    ).toBe('codex')
  })

  test('detects codex when node flags precede the npm entrypoint', () => {
    expect(
      resolveTerminalInputProfile({
        args: [
          '--enable-source-maps',
          'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
        ],
        command: 'node.exe',
        commandPresetId: null,
        interactiveCommand: null,
      })
    ).toBe('codex')
  })

  test('detects codex from an interactiveCommand that still carries flags', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: 'cmd.exe',
        commandPresetId: null,
        interactiveCommand: 'codex --yolo',
      })
    ).toBe('codex')
  })

  test('detects opencode from session capture metadata', () => {
    expect(
      resolveTerminalInputProfile({
        args: [],
        command: 'node.exe',
        commandPresetId: null,
        interactiveCommand: null,
        sessionIdCapture: {
          pattern: '~/.local/share/opencode/opencode.db',
          source: 'opencode_session_db',
        },
      })
    ).toBe('opencode')
  })

  test('detects claude from a shell-wrapped startup command', () => {
    expect(
      resolveTerminalInputProfile({
        args: ['/d', '/s', '/c', 'claude --dangerously-skip-permissions'],
        command: 'cmd.exe',
        commandPresetId: null,
        interactiveCommand: null,
      })
    ).toBe('claude')
  })
})
