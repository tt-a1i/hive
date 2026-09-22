import { describe, expect, test } from 'vitest'

import { resolveStartupCommandLaunchConfig } from '../../src/server/agent-launch-resolver.js'
import { BUILTIN_COMMAND_PRESETS } from '../../src/server/command-preset-defaults.js'
import type { CommandPresetRecord } from '../../src/server/command-preset-store.js'
import type { SettingsStore } from '../../src/server/settings-store.js'

/**
 * Minimal SettingsStore stub backed by the same builtin preset data the
 * real store seeds with. We only exercise `getCommandPreset` here — the
 * resolver doesn't call any other surface.
 *
 * NOTE: This is a stub, not a mock — assertions below verify the resolver's
 * outputs (interactiveCommand, sessionIdCapture), not how the resolver
 * calls the stub. That keeps the test honest under AGENTS.md §III.7.
 */
const createBuiltinPresetSettingsStub = (): SettingsStore => {
  const presetRecord = (id: string): CommandPresetRecord | undefined => {
    const builtin = BUILTIN_COMMAND_PRESETS.find((preset) => preset.id === id)
    if (!builtin) return undefined
    return {
      args: [],
      command: builtin.command,
      displayName: builtin.displayName,
      env: {},
      id: builtin.id,
      isBuiltin: true,
      resumeArgsTemplate: builtin.resumeArgsTemplate,
      sessionIdCapture: builtin.sessionIdCapture,
      yoloArgsTemplate: builtin.yoloArgsTemplate,
    }
  }

  const notImplemented = () => {
    throw new Error('not implemented in stub')
  }

  return {
    createCommandPreset: notImplemented,
    createRoleTemplate: notImplemented,
    deleteCommandPreset: notImplemented,
    deleteRoleTemplate: notImplemented,
    findRoleTemplateByName: notImplemented,
    getAppState: () => undefined,
    getCommandPreset: presetRecord,
    listCommandPresets: () => [],
    listRoleTemplates: () => [],
    setAppState: notImplemented,
    updateCommandPreset: notImplemented,
    updateRoleTemplate: notImplemented,
  }
}

describe('resolveStartupCommandLaunchConfig — CLI brand identification', () => {
  const settings = createBuiltinPresetSettingsStub()

  test('identifies a bare claude command and inherits session capture', () => {
    const result = resolveStartupCommandLaunchConfig(settings, 'claude --continue')
    expect(result?.sessionIdCapture?.source).toBe('claude_project_jsonl_dir')
    expect(result?.interactiveCommand).toBeTruthy()
  })

  test('identifies a Windows quoted path with spaces (the nvm4w + claude.cmd case)', () => {
    // This is the bug reported on the user end: Windows users habitually
    // wrap absolute paths in double quotes. Previously the extractor's
    // regex forbade spaces inside the capture, returning null, and CLI
    // brand identification fell off the cliff — losing session capture,
    // post-start input strategy, and terminal input profile.
    const result = resolveStartupCommandLaunchConfig(
      settings,
      '"C:\\Program Files\\nodejs\\claude.cmd" --continue'
    )
    expect(result?.sessionIdCapture?.source).toBe('claude_project_jsonl_dir')
  })

  test('identifies a Windows path with case-different .CMD suffix and no quotes', () => {
    const result = resolveStartupCommandLaunchConfig(
      settings,
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.CMD --resume abc'
    )
    expect(result?.sessionIdCapture?.source).toBe('claude_project_jsonl_dir')
  })

  test('identifies a POSIX absolute path to codex', () => {
    const result = resolveStartupCommandLaunchConfig(settings, '/usr/local/bin/codex resume xyz')
    expect(result?.sessionIdCapture?.source).toBe('codex_session_jsonl_dir')
  })

  test('identifies a single-quoted Windows path with spaces to opencode', () => {
    const result = resolveStartupCommandLaunchConfig(
      settings,
      "'C:\\path with spaces\\opencode.cmd' --session abc"
    )
    expect(result?.sessionIdCapture?.source).toBe('opencode_session_db')
  })

  test('identifies gemini', () => {
    const result = resolveStartupCommandLaunchConfig(settings, 'gemini --yolo')
    expect(result?.sessionIdCapture?.source).toBe('gemini_session_json_dir')
  })

  test('identifies hermes', () => {
    const result = resolveStartupCommandLaunchConfig(settings, 'hermes --yolo')
    expect(result?.sessionIdCapture?.source).toBe('stdout_regex')
    expect(result?.interactiveCommand).toBe('hermes')
  })

  test('user-defined commands without a matching preset have no sessionIdCapture but still get an interactiveCommand', () => {
    // A user wraps their own shell script: there's no preset to inherit
    // session capture from, but the resolver should still emit a non-null
    // interactiveCommand so downstream missing-binary diagnostics and
    // terminal input profile selection can fire.
    const result = resolveStartupCommandLaunchConfig(
      settings,
      '"C:\\my tools\\custom-agent.cmd" --flag'
    )
    expect(result?.sessionIdCapture).toBeNull()
    expect(result?.interactiveCommand).toBeTruthy()
  })

  test('respects an explicit commandPresetId override even if the startup command looks like a different CLI', () => {
    // If the caller passes commandPresetId, we trust that — the bare
    // startup command may be a wrapper that ultimately launches the preset.
    const result = resolveStartupCommandLaunchConfig(
      settings,
      '"C:\\my wrapper\\runner.cmd" --target=codex',
      'codex'
    )
    expect(result?.sessionIdCapture?.source).toBe('codex_session_jsonl_dir')
  })
})
