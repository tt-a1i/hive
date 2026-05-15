import type { Database } from 'better-sqlite3'

import type { SessionIdCaptureConfig } from './session-capture.js'
import { parseSessionIdCapture } from './session-capture.js'

export interface AgentLaunchConfigInput {
  command: string
  args?: string[]
  commandPresetId?: string | null
  interactiveCommand?: string | null
  presetAugmentationDisabled?: boolean
  resumedSessionId?: string | null
  resumeArgsTemplate?: string | null
  sessionIdCapture?: SessionIdCaptureConfig | null
}

export interface PersistedAgentRun {
  runId: string
  agentId: string
  status: 'starting' | 'running' | 'exited' | 'error'
  exitCode: number | null
  pid: number | null
  startedAt: number
  endedAt: number | null
}

const parseArgsJson = (argsJson: string, agentId: string) => {
  try {
    const parsed = JSON.parse(argsJson) as unknown
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed
    }
  } catch (error) {
    console.warn(`Invalid args_json for agent ${agentId}; falling back to empty args`, error)
    return []
  }

  console.warn(`Invalid args_json for agent ${agentId}; falling back to empty args`)
  return []
}

interface LaunchConfigRow {
  workspace_id: string
  agent_id: string
  command: string
  args_json: string
  command_preset_id: string | null
  interactive_command: string | null
  preset_augmentation_disabled: number | null
  resume_args_template: string | null
  session_id_capture_json: string | null
}

const parseSessionIdCaptureJson = (value: string | null) => {
  if (!value) return null
  return parseSessionIdCapture(JSON.parse(value))
}

interface AgentRunRow {
  run_id: string
  agent_id: string
  pid: number | null
  status: 'starting' | 'running' | 'exited' | 'error'
  exit_code: number | null
  started_at: number
  ended_at: number | null
}

export const createAgentRunStore = (db: Database) => {
  let closed = false
  const initialize = () => {}

  const close = () => {
    closed = true
  }

  const listLaunchConfigs = () => {
    if (closed) {
      return []
    }

    return db
      .prepare(
        `SELECT workspace_id, agent_id, command, args_json, command_preset_id, interactive_command, preset_augmentation_disabled, resume_args_template, session_id_capture_json
         FROM agent_launch_configs ORDER BY updated_at ASC`
      )
      .all()
      .map((row: unknown) => {
        const typedRow = row as LaunchConfigRow
        return {
          agentId: typedRow.agent_id,
          config: {
            command: typedRow.command,
            args: parseArgsJson(typedRow.args_json, typedRow.agent_id),
            commandPresetId: typedRow.command_preset_id,
            interactiveCommand: typedRow.interactive_command,
            presetAugmentationDisabled: typedRow.preset_augmentation_disabled === 1,
            resumeArgsTemplate: typedRow.resume_args_template,
            sessionIdCapture: parseSessionIdCaptureJson(typedRow.session_id_capture_json),
          },
          workspaceId: typedRow.workspace_id,
        }
      })
  }

  const saveLaunchConfig = (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => {
    if (closed) {
      return
    }
    const createdAt = Date.now()
    db.prepare(
      `INSERT INTO agent_launch_configs (
         workspace_id,
         agent_id,
         command,
         args_json,
         command_preset_id,
         interactive_command,
         preset_augmentation_disabled,
         resume_args_template,
         session_id_capture_json,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
          command = excluded.command,
          args_json = excluded.args_json,
          command_preset_id = excluded.command_preset_id,
          interactive_command = excluded.interactive_command,
          preset_augmentation_disabled = excluded.preset_augmentation_disabled,
          resume_args_template = excluded.resume_args_template,
          session_id_capture_json = excluded.session_id_capture_json,
          updated_at = excluded.updated_at`
    ).run(
      workspaceId,
      agentId,
      input.command,
      JSON.stringify(input.args ?? []),
      input.commandPresetId ?? null,
      input.interactiveCommand ?? null,
      input.presetAugmentationDisabled ? 1 : 0,
      input.resumeArgsTemplate ?? null,
      input.sessionIdCapture ? JSON.stringify(input.sessionIdCapture) : null,
      createdAt,
      createdAt
    )
  }

  const deleteLaunchConfig = (workspaceId: string, agentId: string) => {
    if (closed) {
      return
    }
    db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?').run(
      workspaceId,
      agentId
    )
  }

  const insertAgentRun = (
    runId: string,
    agentId: string,
    startedAt: number,
    pid: number | null,
    status: PersistedAgentRun['status'] = 'starting',
    exitCode: number | null = null,
    endedAt: number | null = null
  ) => {
    if (closed) {
      return
    }
    db.prepare(
      `INSERT INTO agent_runs (run_id, agent_id, pid, status, exit_code, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(runId, agentId, pid, status, exitCode, startedAt, endedAt, startedAt, startedAt)
  }

  const updatePersistedRun = (
    runId: string,
    status: PersistedAgentRun['status'],
    exitCode: number | null,
    endedAt: number | null
  ) => {
    if (closed) {
      return
    }
    db.prepare(
      'UPDATE agent_runs SET status = ?, exit_code = ?, ended_at = ?, updated_at = ? WHERE run_id = ?'
    ).run(status, exitCode, endedAt, Date.now(), runId)
  }

  const listAgentRuns = (agentId: string) => {
    if (closed) {
      return []
    }

    return db
      .prepare(
        'SELECT run_id, agent_id, pid, status, exit_code, started_at, ended_at FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC'
      )
      .all(agentId)
      .map((row: unknown) => {
        const typedRow = row as AgentRunRow
        return {
          runId: typedRow.run_id,
          agentId: typedRow.agent_id,
          pid: typedRow.pid,
          status: typedRow.status,
          exitCode: typedRow.exit_code,
          startedAt: typedRow.started_at,
          endedAt: typedRow.ended_at,
        }
      }) satisfies PersistedAgentRun[]
  }

  const markUnfinishedRunsStale = (endedAt = Date.now()) => {
    if (closed) {
      return
    }
    db.prepare(
      `UPDATE agent_runs
       SET status = 'error', exit_code = NULL, ended_at = ?, updated_at = ?
       WHERE status IN ('starting', 'running')`
    ).run(endedAt, endedAt)
  }

  return {
    close,
    initialize,
    insertAgentRun,
    deleteLaunchConfig,
    listAgentRuns,
    listLaunchConfigs,
    markUnfinishedRunsStale,
    saveLaunchConfig,
    updatePersistedRun,
  }
}
