import { afterEach, expect, test, vi } from 'vitest'
import { codexTeamEnvironmentArgs } from '../../src/server/codex-team-environment.js'

afterEach(() => vi.unstubAllEnvs())

test.each([
  undefined,
  '',
  '0',
  'true',
])('does not override shell policy without explicit opt-in (%s)', (flag) => {
  vi.stubEnv('HIVE_CODEX_TEAM_ENV', flag)
  const args = ['--config', 'shell_environment_policy.inherit="core"']
  expect(codexTeamEnvironmentArgs('codex', args)).toEqual(args)
})

test.each(['claude', 'node', null])('does not modify another command (%s)', (command) => {
  vi.stubEnv('HIVE_CODEX_TEAM_ENV', '1')
  expect(codexTeamEnvironmentArgs(command, ['--help'])).toEqual(['--help'])
})

test.each([
  { launchArgs: [] },
  { launchArgs: ['resume', 'test-session'] },
])('opt-in preserves launch arguments and passes only environment names ($launchArgs)', ({
  launchArgs,
}) => {
  vi.stubEnv('HIVE_CODEX_TEAM_ENV', '1')
  // Synthetic sentinel only: never read a real credential into the assertion output.
  vi.stubEnv('HIVE_AGENT_TOKEN', 'synthetic-credential-must-not-enter-argv')
  const original = [...launchArgs]
  const args = codexTeamEnvironmentArgs('codex', launchArgs)
  expect(args.slice(0, launchArgs.length)).toEqual(original)
  expect(launchArgs).toEqual(original)
  expect(args.slice(launchArgs.length, launchArgs.length + 5)).toEqual([
    '--config',
    'shell_environment_policy.inherit="all"',
    '--config',
    'shell_environment_policy.ignore_default_excludes=true',
    '--config',
  ])
  expect(args).toHaveLength(original.length + 6)
  const policy = args.at(-1) ?? ''
  expect(policy.startsWith('shell_environment_policy.include_only=')).toBe(true)
  const keys: string[] = JSON.parse(policy.slice(policy.indexOf('=') + 1))
  expect(keys.filter((key) => key.startsWith('HIVE_'))).toEqual([
    'HIVE_PORT',
    'HIVE_PROJECT_ID',
    'HIVE_AGENT_ID',
    'HIVE_AGENT_TOKEN',
  ])
  expect(keys).toContain('PATH')
  expect(keys).toContain('SYSTEMROOT')
  expect(keys).not.toContain('*')
  expect(args.join('\n')).not.toContain('synthetic-credential-must-not-enter-argv')
})
