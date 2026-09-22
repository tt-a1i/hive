import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { runHiveCommand } from '../../src/cli/hive.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

afterEach(() => vi.unstubAllEnvs())

// A real executable receiver, not Codex itself: proves HTTP -> SQLite launch
// configuration -> real PTY argv/env delivery, not Codex's shell policy semantics.
test.each([
  false,
  true,
])('real launch delivers opt-in policy only when enabled=%s', async (enabled) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-codex-env-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath)
  vi.stubEnv('HIVE_DATA_DIR', join(root, 'data'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('CODEX_HOME', join(root, '.codex'))
  vi.stubEnv('HIVE_CODEX_TEAM_ENV', enabled ? '1' : '0')
  const script = join(root, 'receiver.cjs')
  writeFileSync(
    script,
    `
const args = process.argv.slice(2);
const prefix = 'shell_environment_policy.include_only=';
const policy = args.find(a => a.startsWith(prefix));
const keys = policy ? JSON.parse(policy.slice(prefix.length)) : [];
const required = ['HIVE_PORT','HIVE_PROJECT_ID','HIVE_AGENT_ID','HIVE_AGENT_TOKEN'];
const emit = (name, value) => process.stdout.write(name + '=' + value + '\\r\\n');
emit('POLICY', args.includes('shell_environment_policy.inherit="all"') && args.includes('shell_environment_policy.ignore_default_excludes=true') && required.every(k => keys.includes(k)));
emit('ENV_PRESENT', required.every(k => Boolean(process.env[k])));
emit('TOKEN_IN_ARGV', args.some(a => a.includes(process.env.HIVE_AGENT_TOKEN)));
emit('RESUME', args.includes('resume') && args.includes('fixture-session'));
process.stdout.write('SESSION_ID:fixture-session\\r\\n');
const { spawnSync } = require('node:child_process');
const team = spawnSync(process.execPath, ['--import', 'tsx', ${JSON.stringify(resolve('bin/team'))}, 'list'], {
  cwd: ${JSON.stringify(process.cwd())}, env: process.env, encoding: 'utf8', timeout: 10000, windowsHide: true
});
emit('TEAM_EXIT', team.status);
if (team.status === 0) emit('TEAM_EMPTY', JSON.stringify(JSON.parse(team.stdout)) === '[]');
process.stdout.write('❯\\r\\n');
process.stdin.setRawMode(true);
let pendingInput = '';
let pasteAcknowledged = false;
let probe = false;
process.stdin.on('data', chunk => {
  pendingInput += chunk.toString('utf8');
  const pasteEnd = pendingInput.indexOf('\\x1b[201~');
  if (!pasteAcknowledged && pasteEnd !== -1) {
    pasteAcknowledged = true;
    probe = pendingInput.slice(0, pasteEnd).includes('RECOVERY_PROBE');
    pendingInput = pendingInput.slice(pasteEnd + 6);
    process.stdout.write('\\r\\n[Pasted text #1 +1 lines]\\r\\n');
  }
  if (pasteAcknowledged && /^[\\r\\n]+$/.test(pendingInput)) {
    emit(probe ? 'PROBE_SUBMITTED' : 'STARTUP_SUBMITTED', true);
    pasteAcknowledged = false;
    pendingInput = '';
    process.stdout.write('❯\\r\\n');
  }
});
process.stdin.resume();
`
  )
  const command = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  writeFileSync(
    command,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`
  )
  if (process.platform !== 'win32') chmodSync(command, 0o755)
  const hive = await runHiveCommand(['--port', '0'])
  try {
    const base = `http://127.0.0.1:${hive.port}`
    const headers = { 'content-type': 'application/json', cookie: await getUiCookie(base) }
    const created = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: workspacePath,
        name: 'Environment fixture',
        autostart_orchestrator: false,
      }),
    })
    expect(created.status).toBe(201)
    const workspace = (await created.json()) as { id: string }
    const agent = `${base}/api/workspaces/${workspace.id}/agents/${workspace.id}:orchestrator`
    // The fixture emits a session banner. Hive must capture and restore it;
    // the test never seeds SQLite or supplies resume arguments in launch config.
    const presetResponse = await fetch(`${base}/api/settings/command-presets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        display_name: 'Codex receiver',
        command,
        args: [],
        resume_args_template: 'resume {session_id}',
        session_id_capture: { source: 'stdout_regex', pattern: 'SESSION_ID:([a-z-]+)' },
      }),
    })
    expect(presetResponse.status).toBe(201)
    const preset = (await presetResponse.json()) as { id: string }
    const configured = await fetch(`${agent}/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command, args: [], command_preset_id: preset.id }),
    })
    expect(configured.ok).toBe(true)
    const runIds = new Set<string>()
    for (const resumed of [false, true]) {
      const started = await fetch(`${agent}/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })
      expect(started.ok).toBe(true)
      const run = (await started.json()) as { run_id: string }
      expect(runIds.has(run.run_id)).toBe(false)
      runIds.add(run.run_id)
      await expect
        .poll(
          async () => {
            const response = await fetch(`${base}/api/runtime/runs/${run.run_id}`, { headers })
            expect(response.ok).toBe(true)
            return ((await response.json()) as { output: string }).output
          },
          { timeout: 15000 }
        )
        .toContain('TEAM_EMPTY=true')
      const response = await fetch(`${base}/api/runtime/runs/${run.run_id}`, { headers })
      const { output } = (await response.json()) as { output: string }
      expect(output).toContain(`POLICY=${enabled}`)
      expect(output).toContain('ENV_PRESENT=true')
      expect(output).toContain('TOKEN_IN_ARGV=false')
      expect(output).toContain(`RESUME=${resumed}`)
      expect(output).toContain('TEAM_EXIT=0')
      if (!resumed) {
        await expect
          .poll(
            async () => {
              const response = await fetch(`${base}/api/runtime/runs/${run.run_id}`, { headers })
              return ((await response.json()) as { output: string }).output
            },
            { timeout: 15000 }
          )
          .toContain('STARTUP_SUBMITTED=true')
      }
      const input = await fetch(`${base}/api/workspaces/${workspace.id}/user-input`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'RECOVERY_PROBE' }),
      })
      expect(input.status).toBe(202)
      await expect
        .poll(
          async () => {
            const response = await fetch(`${base}/api/runtime/runs/${run.run_id}`, { headers })
            return ((await response.json()) as { output: string }).output
          },
          { timeout: 15000 }
        )
        .toContain('PROBE_SUBMITTED=true')
      const stopped = await fetch(`${base}/api/runtime/runs/${run.run_id}/stop`, {
        method: 'POST',
        headers,
      })
      expect(stopped.ok).toBe(true)
      await expect
        .poll(
          async () => {
            const response = await fetch(`${base}/api/runtime/runs/${run.run_id}`, { headers })
            return ((await response.json()) as { status: string }).status
          },
          { timeout: 15000 }
        )
        .toBe('exited')
    }
  } finally {
    await hive.close()
    removeTestPath(root)
  }
}, 30000)
