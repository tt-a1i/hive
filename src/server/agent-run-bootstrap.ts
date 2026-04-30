import { delimiter, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { withPresetResumeArgs } from './preset-launch-support.js'
import {
  captureSessionIdForCapture,
  getSessionCaptureEnvironment,
  type SessionCaptureSnapshot,
  snapshotSessionIdsForCapture,
} from './session-capture.js'

const resolveHiveBinDir = () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = resolve(moduleDir, '../..')
  return moduleDir.includes(`${sep}dist${sep}src${sep}`)
    ? resolve(packageRoot, 'bin')
    : resolve(packageRoot, 'dist/bin')
}

const HIVE_BIN_DIR = resolveHiveBinDir()
const SESSION_CAPTURE_TIMEOUT_MS = 30_000

type LaunchPreset = Pick<
  CommandPresetRecord,
  'resumeArgsTemplate' | 'sessionIdCapture' | 'yoloArgsTemplate'
>

const resolveLaunchPreset = (
  config: AgentLaunchConfigInput,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
): LaunchPreset | undefined => {
  if (config.commandPresetId) return getCommandPreset(config.commandPresetId)

  const implicitPreset = getCommandPreset(config.command)
  if (!implicitPreset || implicitPreset.command !== config.command) return undefined

  return {
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: implicitPreset.yoloArgsTemplate,
  }
}

export const buildAgentRunBootstrap = (
  workspace: WorkspaceSummary,
  agentId: string,
  config: AgentLaunchConfigInput,
  sessionStore: AgentSessionStorePort,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
) => {
  const preset = resolveLaunchPreset(config, getCommandPreset)
  const startConfig = withPresetResumeArgs(
    config,
    preset,
    sessionStore.getLastSessionId(workspace.id, agentId),
    workspace.path
  )
  const sessionCaptureSnapshot = snapshotSessionIdsForCapture(
    workspace.path,
    startConfig.sessionIdCapture
  )
  return {
    sessionCaptureSnapshot,
    startConfig,
    startEnv: {
      ...getSessionCaptureEnvironment(sessionCaptureSnapshot),
      HIVE_PORT: '',
      HIVE_PROJECT_ID: workspace.id,
      HIVE_AGENT_ID: agentId,
      HIVE_AGENT_TOKEN: '',
      PATH: `${HIVE_BIN_DIR}${delimiter}${process.env.PATH ?? ''}`,
    },
  }
}

export const startAgentRunCapture = ({
  agentId,
  sessionCaptureSnapshot,
  sessionStore,
  startConfig,
  workspace,
}: {
  agentId: string
  sessionCaptureSnapshot: SessionCaptureSnapshot | undefined
  sessionStore: AgentSessionStorePort
  startConfig: AgentLaunchConfigInput
  workspace: WorkspaceSummary
}) => {
  if (!sessionCaptureSnapshot || !startConfig.sessionIdCapture) return
  void captureSessionIdForCapture(
    workspace.path,
    startConfig.sessionIdCapture,
    sessionCaptureSnapshot,
    (sessionId) => {
      sessionStore.setLastSessionId(workspace.id, agentId, sessionId)
    },
    SESSION_CAPTURE_TIMEOUT_MS
  )
}
