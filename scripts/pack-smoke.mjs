import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const tempDir = mkdtempSync(join(tmpdir(), 'hive-pack-smoke-'))
let packedFile
const binLinkName = (name) => (process.platform === 'win32' ? `${name}.cmd` : name)
const runtimeStartTimeoutMs = process.platform === 'win32' ? 60_000 : 5_000

const runNpm = (args, options = {}) =>
  process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options)
    : execFileSync('npm', args, options)

const removePath = (path) => {
  rmSync(path, {
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 0,
    recursive: true,
    retryDelay: 100,
  })
}

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 25))
  }
  throw new Error('Timed out waiting for packaged hive runtime to start')
}

const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return

  await new Promise((resolveExit) => {
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2000)

    child.once('exit', () => {
      clearTimeout(forceKill)
      resolveExit()
    })

    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      } catch {
        child.kill('SIGKILL')
      }
      return
    }

    child.kill('SIGTERM')
  })
}

try {
  const packJson = runNpm(['pack', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const [packResult] = JSON.parse(packJson)
  packedFile = resolve(root, packResult.filename)

  runNpm(['install', '--silent', '--prefix', tempDir, packedFile], {
    stdio: 'inherit',
  })

  const packageRoot = join(tempDir, 'node_modules', '@tt-a1i', 'hive')
  const hiveBin = join(tempDir, 'node_modules', '.bin', binLinkName('hive'))
  const teamBin = join(tempDir, 'node_modules', '.bin', 'team')
  const teamCmdBin = join(tempDir, 'node_modules', '.bin', 'team.cmd')
  const internalTeam = join(packageRoot, 'dist', 'bin', 'team')
  const internalTeamCmd = join(packageRoot, 'dist', 'bin', 'team.cmd')

  if (!existsSync(hiveBin)) throw new Error('Packaged hive bin was not linked')
  if (existsSync(teamBin) || existsSync(teamCmdBin)) {
    throw new Error('team must not be exposed as a global package bin')
  }
  if (!existsSync(internalTeam)) throw new Error('Internal dist/bin/team is missing')
  if (!existsSync(internalTeamCmd)) throw new Error('Internal dist/bin/team.cmd is missing')

  const child = spawn(hiveBin, ['--port', '0'], {
    env: {
      ...process.env,
      HIVE_DATA_DIR: join(tempDir, 'data'),
      HIVE_ORCHESTRATOR_COMMAND: process.execPath,
      HIVE_ORCHESTRATOR_ARGS_JSON: JSON.stringify(['-e', 'setInterval(() => {}, 1000)']),
    },
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  try {
    const port = await waitFor(() => {
      const match = stdout.match(/Hive running at http:\/\/127\.0\.0\.1:(\d+)/)
      return match?.[1]
    }, runtimeStartTimeoutMs).catch((error) => {
      const childOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
      throw new Error(`${error.message}${childOutput ? `\n${childOutput}` : ''}`)
    })
    const response = await fetch(`http://127.0.0.1:${port}/`)
    if (response.status !== 200) {
      throw new Error(`Packaged runtime root returned ${response.status}`)
    }
    const html = await response.text()
    if (!html.includes('<div id="root"></div>')) {
      throw new Error('Packaged runtime did not serve the bundled web UI')
    }
  } finally {
    await stopChild(child)
  }

  if (stderr) {
    console.warn(stderr.trim())
  }
} finally {
  if (packedFile) removePath(packedFile)
  removePath(tempDir)
}
