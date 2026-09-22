import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'

const originalEnv = { ...process.env }
const originalCwd = process.cwd()
const tempDirs: string[] = []

afterEach(() => {
  process.chdir(originalCwd)
  process.env = { ...originalEnv }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
  vi.restoreAllMocks()
})

describe('team cli help', () => {
  test('prints usage without requiring Hive agent environment', async () => {
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['--help'])).resolves.toBeUndefined()

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toContain('Usage:')
    expect(output).toContain('team list')
    expect(output).toContain('team guide <core|dispatch|tasks|memory|workflow|member>')
    expect(output).toContain('team recall "<query>"')
    expect(output).toContain('team memory add "<body>"')
    expect(output).toContain('team memory show <memory-id>')
    expect(output).toContain('team memory search "<query>"')
    expect(output).toContain('team memory dream show <dream-run-id>')
    expect(output).toContain('team memory apply --run <dream-run-id> --stdin')
    expect(output).toContain('team memory forget <memory-id>')
    expect(output).toContain('team send <member-name> "<task>"')
    expect(output).toContain('team cancel --dispatch <dispatch-id> "<reason>"')
    expect(output).toContain('team report "<result>"')
    expect(output).toContain('team status "<current status>"')
    expect(output).not.toContain('team workflow run')
    expect(output).not.toContain('--success')
    expect(output).not.toContain('--failed')
  })

  test('team guide prints focused runtime guidance without requiring Hive env', async () => {
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['guide', 'dispatch'])).resolves.toBeUndefined()

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toContain('## Guide: dispatch')
    expect(output).toContain('team send "<member-name>" "<task>"')
    expect(output).toContain('existing members from `team list` by name')
    expect(output).toContain('Preserve configured CLI, model, and role constraints')
  })

  test('team guide prefers the generated protocol slice when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-team-guide-'))
    tempDirs.push(dir)
    // Resolve the Windows temp directory before removing the CLI environment.
    process.env = {}
    mkdirSync(join(dir, '.hive'), { recursive: true })
    writeFileSync(
      join(dir, '.hive', 'PROTOCOL.md'),
      [
        '# Hive Team Protocol',
        '',
        '## Guide: workflow',
        '',
        'generated workflow guide with enabled command: team workflow run --stdin',
        '',
        '## Guide: member',
        '',
        'member guide',
      ].join('\n')
    )
    process.chdir(dir)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['guide', 'workflow'])).resolves.toBeUndefined()

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toContain('generated workflow guide')
    expect(output).toContain('team workflow run --stdin')
    expect(output).not.toContain('Workflow commands are disabled')
  })

  test('--stdin guidance covers both POSIX and Windows shells', async () => {
    // Earlier this file only documented POSIX heredoc (`<<'EOF'`), which
    // is a cmd.exe / PowerShell syntax error. Agents running in a Windows
    // PTY would copy the example verbatim and hit "command not found".
    // The TEAM_USAGE block should mention at minimum: POSIX heredoc, a
    // cmd-native pipe pattern, and a PowerShell-native form. Locking the
    // contract here so the same regression doesn't re-land as it did
    // before commit 0e47cc1.
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runTeamCommand(['--help'])

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toMatch(/POSIX/)
    expect(output).toMatch(/<<'EOF'/)
    expect(output).toMatch(/type body\.txt \| team report --stdin/)
    expect(output).toMatch(/Get-Content -Raw -Encoding utf8 body\.txt/)
  })

  test('team report warns when Hive records the report but cannot live-deliver it', async () => {
    process.env = {
      HIVE_AGENT_ID: 'worker-1',
      HIVE_AGENT_TOKEN: 'token-1',
      HIVE_PORT: '12345',
      HIVE_PROJECT_ID: 'workspace-1',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              dispatch_id: 'dispatch-1',
              forward_error: 'No active run for agent: workspace-1:orchestrator',
              forwarded: false,
              ok: true,
            }),
            { headers: { 'content-type': 'application/json' }, status: 202 }
          )
      )
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runTeamCommand(['report', 'Done'])

    expect(errorSpy).toHaveBeenCalledWith(
      'Hive recorded the report, but could not deliver it to Orchestrator in real time: No active run for agent: workspace-1:orchestrator'
    )
  })

  test('team report does not warn when Hive is durably delivering to an active Orchestrator', async () => {
    process.env = {
      HIVE_AGENT_ID: 'worker-1',
      HIVE_AGENT_TOKEN: 'token-1',
      HIVE_PORT: '12345',
      HIVE_PROJECT_ID: 'workspace-1',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              delivery_state: 'delivering',
              dispatch_id: 'dispatch-1',
              forward_error: null,
              forwarded: false,
              ok: true,
            }),
            { headers: { 'content-type': 'application/json' }, status: 202 }
          )
      )
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runTeamCommand(['report', 'Done'])

    expect(errorSpy).not.toHaveBeenCalled()
  })
})
