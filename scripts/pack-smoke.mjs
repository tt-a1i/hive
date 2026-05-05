import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const tempDir = mkdtempSync(join(tmpdir(), 'hive-pack-smoke-'))
let packedFile

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
    child.kill('SIGTERM')
  })
}

try {
  const packJson = execFileSync('npm', ['pack', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const [packResult] = JSON.parse(packJson)
  packedFile = resolve(root, packResult.filename)

  execFileSync('npm', ['install', '--silent', '--prefix', tempDir, packedFile], {
    stdio: 'inherit',
  })

  const packageRoot = join(tempDir, 'node_modules', '@tt-a1i', 'hive')
  const hiveBin = join(tempDir, 'node_modules', '.bin', 'hive')
  const teamBin = join(tempDir, 'node_modules', '.bin', 'team')
  const internalTeam = join(packageRoot, 'dist', 'bin', 'team')

  if (!existsSync(hiveBin)) throw new Error('Packaged hive bin was not linked')
  if (existsSync(teamBin)) throw new Error('team must not be exposed as a global package bin')
  if (!existsSync(internalTeam)) throw new Error('Internal dist/bin/team is missing')

  const child = spawn(hiveBin, ['--port', '0'], {
    env: {
      ...process.env,
      HIVE_DATA_DIR: join(tempDir, 'data'),
      HIVE_ORCHESTRATOR_COMMAND: process.execPath,
      HIVE_ORCHESTRATOR_ARGS_JSON: JSON.stringify(['-e', 'setInterval(() => {}, 1000)']),
    },
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
  if (packedFile) rmSync(packedFile, { force: true })
  rmSync(tempDir, { force: true, recursive: true })
}
