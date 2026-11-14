import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, test } from 'vitest'
import { resolveCommandPresetLaunchConfig } from '../../src/server/agent-launch-resolver.js'
import type { CommandPresetRecord } from '../../src/server/command-preset-store.js'
import { nativeIdentityArgs } from '../../src/server/native-agent-identity.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { createSettingsStore } from '../../src/server/settings-store.js'
import type { AgentSummary } from '../../src/shared/types.js'

const agent = { role: 'coder' } as AgentSummary
const preset: CommandPresetRecord = {
  id: 'claude',
  displayName: 'Claude',
  command: 'claude',
  isBuiltin: true,
  args: [],
  env: {},
  resumeArgsTemplate: null,
  sessionIdCapture: null,
  yoloArgsTemplate: null,
}

test.runIf(process.platform !== 'win32')(
  'uses advertised additive support without changing custom or resumed launches',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-native-identity-'))
    try {
      const executable = join(dir, 'claude')
      writeFileSync(executable, '#!/bin/sh\necho --append-system-prompt\n')
      chmodSync(executable, 0o755)
      const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` }
      const db = openRuntimeDatabase()
      const settings = createSettingsStore(db)
      const actualPreset = settings.getCommandPreset('claude')
      const config = resolveCommandPresetLaunchConfig(settings, 'claude')
      expect(config).toBeDefined()
      expect(config?.args).toEqual(actualPreset?.args)
      if (!config || !actualPreset) throw new Error('Missing builtin Claude preset')
      expect(await nativeIdentityArgs(config, actualPreset, agent, env, false)).toEqual([
        '--append-system-prompt',
        expect.stringContaining('Hive member'),
      ])
      db.close()
      const presetWithArgs = { ...preset, args: ['--model', 'default-model'] }
      const withPresetArgs = { ...config, args: [...presetWithArgs.args] }
      expect(await nativeIdentityArgs(withPresetArgs, presetWithArgs, agent, env, false)).toEqual([
        '--append-system-prompt',
        expect.stringContaining('Hive member'),
      ])
      expect(await nativeIdentityArgs(config, preset, agent, env, false)).toEqual([
        '--append-system-prompt',
        expect.stringContaining('Hive member'),
      ])
      expect(await nativeIdentityArgs(config, preset, agent, env, true)).toEqual([])
      expect(
        await nativeIdentityArgs(
          { ...config, command: 'codex', commandPresetId: 'codex' },
          preset,
          agent,
          env,
          false
        )
      ).toEqual([])
      expect(
        await nativeIdentityArgs(
          { ...config, args: ['--append-system-prompt', 'user instructions'] },
          preset,
          agent,
          env,
          false
        )
      ).toEqual([])
      writeFileSync(executable, '#!/bin/sh\necho unsupported\n')
      expect(await nativeIdentityArgs(config, preset, agent, env, false)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
