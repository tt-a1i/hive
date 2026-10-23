import { dirname, posix, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import {
  buildAgentLegacyIdentityMarker,
  buildAgentSessionBindingMarker,
} from './agent-startup-instructions.js'
import { getBuiltinCommandPresetByCommand } from './command-preset-defaults.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { withPresetResumeArgs } from './preset-launch-support.js'
import {
  captureSessionIdForCapture,
  getSessionCaptureEnvironment,
  type SessionCaptureSnapshot,
  snapshotSessionIdsForCapture,
} from './session-capture.js'
import { getCodexHome } from './session-capture-codex.js'
import { normalizeExecutableToken } from './startup-command-parser.js'

const resolveHiveBinDir = () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = resolve(moduleDir, '../..')
  return moduleDir.includes(`${sep}dist${sep}src${sep}`)
    ? resolve(packageRoot, 'bin')
    : resolve(packageRoot, 'dist/bin')
}

const HIVE_BIN_DIR = resolveHiveBinDir()
const SESSION_CAPTURE_TIMEOUT_MS = 30_000

const getWindowsEnvKey = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  if (Object.hasOwn(env, key)) return key
  return Object.keys(env)
    .filter((item) => item.toLowerCase() === key.toLowerCase())
    .at(-1)
}

/**
 * Builds a `{ <PATH-key>: <new-value> }` object for the spawn env override.
 * Critical on Windows: the OS env block reports PATH under its native casing
 * (typically `Path`). Writing to a literal `PATH` key would, after spread
 * with `process.env`, leave two entries — `Path` carrying the original value
 * and `PATH` carrying our prepend. CreateProcess then sees both and the
 * effective lookup order is undefined; in practice the child PTY often falls
 * back to the original `Path` and never sees `HIVE_BIN_DIR`, breaking every
 * `team` shim resolution.
 *
 * We detect the existing key (case-insensitive on Windows) and overwrite IT,
 * so the merge produces exactly one PATH entry.
 *
 * Exported for unit testing and for `hive update` npm/probe children.
 */
export const buildSpawnPathEnvEntry = (
  parentEnv: NodeJS.ProcessEnv,
  hiveBinDir: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv => {
  const existingKey = platform === 'win32' ? getWindowsEnvKey(parentEnv, 'PATH') : undefined
  const key = existingKey ?? 'PATH'
  const existingValue = existingKey ? parentEnv[existingKey] : parentEnv.PATH
  // Target platform's delimiter — Windows uses `;`, POSIX `:` — independent
  // of where this function is running (tests on macOS verify the win32 path).
  const platformDelimiter = platform === 'win32' ? win32.delimiter : posix.delimiter
  const value = existingValue ? `${hiveBinDir}${platformDelimiter}${existingValue}` : hiveBinDir
  return { [key]: value }
}

type LaunchPreset = Pick<
  CommandPresetRecord,
  'resumeArgsTemplate' | 'sessionIdCapture' | 'yoloArgsTemplate'
>

const resolveLaunchPreset = (
  config: AgentLaunchConfigInput,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
): LaunchPreset | undefined => {
  if (config.presetAugmentationDisabled) return undefined
  if (config.commandPresetId) return getCommandPreset(config.commandPresetId)

  const implicitBuiltin = getBuiltinCommandPresetByCommand(config.command)
  const implicitPreset = getCommandPreset(implicitBuiltin?.id ?? config.command)
  if (!implicitPreset || implicitPreset.command !== config.command) return undefined

  return {
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: implicitPreset.yoloArgsTemplate,
  }
}

const createSessionCaptureDiscriminator = (
  workspace: WorkspaceSummary,
  agent: AgentSummary | undefined
) => {
  if (!agent) return undefined
  return {
    contentIncludes: [
      buildAgentSessionBindingMarker({ agent, workspace }),
      buildAgentLegacyIdentityMarker({ agent, workspace }),
    ],
  }
}

export const buildAgentRunBootstrap = (
  workspace: WorkspaceSummary,
  agentId: string,
  config: AgentLaunchConfigInput,
  sessionStore: AgentSessionStorePort,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined,
  agent?: AgentSummary
) => {
  const cwd = config.cwd?.trim() ? config.cwd : workspace.path
  const preset = resolveLaunchPreset(config, getCommandPreset)
  const discriminator = createSessionCaptureDiscriminator(workspace, agent)
  const startConfig = withPresetResumeArgs(
    config,
    preset,
    sessionStore.getLastSessionId(workspace.id, agentId),
    cwd,
    discriminator,
    () => sessionStore.clearLastSessionId(workspace.id, agentId)
  )
  const sessionCaptureSnapshot = startConfig.resumedSessionId
    ? undefined
    : snapshotSessionIdsForCapture(cwd, startConfig.sessionIdCapture, discriminator)
  const codexCapture =
    startConfig.sessionIdCapture?.source === 'codex_session_jsonl_dir'
      ? startConfig.sessionIdCapture
      : undefined
  const codexHome =
    codexCapture ||
    normalizeExecutableToken(startConfig.interactiveCommand ?? startConfig.command) === 'codex'
      ? getCodexHome(codexCapture?.pattern, process.platform, cwd)
      : undefined
  return {
    sessionCaptureDiscriminator: discriminator,
    sessionCaptureSnapshot,
    startConfig,
    startEnv: {
      ...getSessionCaptureEnvironment(sessionCaptureSnapshot),
      ...(codexHome !== undefined ? { CODEX_HOME: codexHome } : {}),
      HIVE_PORT: '',
      HIVE_PROJECT_ID: workspace.id,
      HIVE_AGENT_ID: agentId,
      HIVE_AGENT_TOKEN: '',
      ...buildSpawnPathEnvEntry(process.env, HIVE_BIN_DIR, process.platform),
    },
  }
}

export const startAgentRunCapture = ({
  agentId,
  getRunOutput,
  sessionCaptureSnapshot,
  sessionStore,
  startConfig,
  workspace,
}: {
  agentId: string
  getRunOutput?: () => string | null
  sessionCaptureSnapshot: SessionCaptureSnapshot | undefined
  sessionStore: AgentSessionStorePort
  startConfig: AgentLaunchConfigInput
  workspace: WorkspaceSummary
}) => {
  if (!sessionCaptureSnapshot || !startConfig.sessionIdCapture) return
  const cwd = startConfig.cwd?.trim() ? startConfig.cwd : workspace.path
  const captureSnapshot =
    startConfig.sessionIdCapture.source === 'stdout_regex' && getRunOutput
      ? { ...sessionCaptureSnapshot, getOutput: getRunOutput }
      : sessionCaptureSnapshot
  void captureSessionIdForCapture(
    cwd,
    startConfig.sessionIdCapture,
    captureSnapshot,
    (sessionId) => {
      sessionStore.setLastSessionId(workspace.id, agentId, sessionId)
    },
    SESSION_CAPTURE_TIMEOUT_MS
  )
}
