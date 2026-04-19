import type { Database } from 'better-sqlite3'

export interface AgentLaunchConfigInput {
  command: string
  args?: string[]
  resumeArgsTemplate?: string | null
  sessionIdCapture?: { pattern: string; source: 'claude_project_jsonl_dir' } | null
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
  resume_args_template: string | null
  session_id_capture_json: string | null
}

const parseSessionIdCaptureJson = (value: string | null) => {
  if (!value) {
    return null
  }

  const parsed = JSON.parse(value) as unknown
  if (
    parsed &&
    typeof parsed === 'object' &&
    'source' in parsed &&
    'pattern' in parsed &&
    parsed.source === 'claude_project_jsonl_dir' &&
    typeof parsed.pattern === 'string'
  ) {
    return parsed as { pattern: string; source: 'claude_project_jsonl_dir' }
  }

  return null
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

export const createAgentRunStore = (db: Database | undefined) => {
  const initialize = () => {}

  const listLaunchConfigs = () => {
    if (!db) {
      return []
    }

    return db
      .prepare(
        `SELECT workspace_id, agent_id, command, args_json, resume_args_template, session_id_capture_json
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
    const createdAt = Date.now()
    db?.prepare(
      `INSERT INTO agent_launch_configs (
         workspace_id,
         agent_id,
         command,
         args_json,
         resume_args_template,
         session_id_capture_json,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
         command = excluded.command,
         args_json = excluded.args_json,
         resume_args_template = excluded.resume_args_template,
         session_id_capture_json = excluded.session_id_capture_json,
         updated_at = excluded.updated_at`
    ).run(
      workspaceId,
      agentId,
      input.command,
      JSON.stringify(input.args ?? []),
      input.resumeArgsTemplate ?? null,
      input.sessionIdCapture ? JSON.stringify(input.sessionIdCapture) : null,
      createdAt,
      createdAt
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
    db?.prepare(
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
    db?.prepare(
      'UPDATE agent_runs SET status = ?, exit_code = ?, ended_at = ?, updated_at = ? WHERE run_id = ?'
    ).run(status, exitCode, endedAt, Date.now(), runId)
  }

  const listAgentRuns = (agentId: string) => {
    if (!db) {
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

  return {
    initialize,
    insertAgentRun,
    listAgentRuns,
    listLaunchConfigs,
    saveLaunchConfig,
    updatePersistedRun,
  }
}
