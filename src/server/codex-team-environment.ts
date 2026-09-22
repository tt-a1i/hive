// Opt-in runtime compatibility for Codex installations whose shell policy is
// `inherit = "core"`. Never put credential values in argv or saved launch config.
const TEAM_SHELL_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_COLLATE',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PSMODULEPATH',
  'HIVE_PORT',
  'HIVE_PROJECT_ID',
  'HIVE_AGENT_ID',
  'HIVE_AGENT_TOKEN',
]

export const codexTeamEnvironmentArgs = (
  command: string | null,
  args: string[] = [],
  enabled = process.env.HIVE_CODEX_TEAM_ENV === '1'
): string[] => {
  if (!enabled || command !== 'codex') return args
  return [
    ...args,
    '--config',
    'shell_environment_policy.inherit="all"',
    '--config',
    'shell_environment_policy.ignore_default_excludes=true',
    '--config',
    `shell_environment_policy.include_only=${JSON.stringify(TEAM_SHELL_KEYS)}`,
  ]
}
