import { execFileSync } from 'node:child_process'

import { spawn, type IPty } from 'node-pty'

export const hasTmux = (): boolean => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export const buildSessionName = (
  workspaceId: string,
  _agentId: string,
  agentName: string
): string => {
  const prefix = workspaceId.slice(0, 4)
  const sanitized = agentName.replace(/[^a-zA-Z0-9_-]/g, '-')
  return `hive-${prefix}-${sanitized}`
}

export const createSession = (
  name: string,
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }
): void => {
  try {
    execFileSync(
      'tmux',
      [
        'new-session',
        '-d',
        '-s', name,
        '-x', String(opts.cols),
        '-y', String(opts.rows),
        '--', command, ...args,
      ],
      { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: 'pipe' }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to create tmux session "${name}": ${message}`)
  }
}

export const attachSession = (name: string): IPty => {
  return spawn('tmux', ['attach-session', '-t', name], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  })
}

export const listHiveSessions = (): string[] => {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      stdio: 'pipe',
      encoding: 'utf8',
    })
    return output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('hive-'))
  } catch {
    return []
  }
}

export const killSession = (name: string): void => {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe' })
  } catch {
    // session may already be dead
  }
}

export const isSessionAlive = (name: string): boolean => {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
