import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentRunStore } from '../../src/server/agent-run-store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
  vi.restoreAllMocks()
})

describe('agent run store args validation', () => {
  test('non-string-array args_json falls back to empty args and warns', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-bad-args-shape-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`CREATE TABLE agent_launch_configs (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      command_preset_id TEXT,
      resume_args_template TEXT,
      session_id_capture_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );`)
    db.prepare(
      `INSERT INTO agent_launch_configs (
         workspace_id,
         agent_id,
         command,
         args_json,
          command_preset_id,
         resume_args_template,
         session_id_capture_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('ws-1', 'agent-1', '/bin/bash', '[1,2]', null, null, null, Date.now(), Date.now())

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const configs = createAgentRunStore(db).listLaunchConfigs()

    expect(configs[0]?.config.args).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
    db.close()
  })
})
