import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const vitestBin = 'node_modules/vitest/vitest.mjs'
const passthrough = process.argv.slice(2)
const stableFullSuiteVitestFlags = [
  '--no-file-parallelism',
  '--maxWorkers=1',
  '--testTimeout=60000',
  '--hookTimeout=60000',
]

const runVitest = async (filesOrArgs = [], extraArgs = []) => {
  const command =
    filesOrArgs[0] === '--related'
      ? ['related', '--run', ...filesOrArgs.slice(1)]
      : ['run', ...filesOrArgs]
  const vitestArgs = [vitestBin, ...command, ...extraArgs]

  // The test entry point must never inherit a user's live runtime database.
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-test-data-'))
  const testHome = join(dataDir, 'home')
  mkdirSync(testHome)
  let child
  let interrupted
  let cancellation
  let cancelTimer
  let finishCancellation
  const stop = (signal) => {
    if (interrupted) return
    interrupted = signal
    if (!child?.pid) return
    if (process.platform === 'win32') {
      const stopped = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        timeout: 5000,
      })
      if (stopped.status !== 0) child.kill(signal)
    } else {
      const signalGroup = (value) => {
        try {
          process.kill(-child.pid, value)
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
      // Nested runners must receive the signal before their parent is killed,
      // so they can stop their own detached children and remove their data.
      signalGroup(signal)
      cancellation = new Promise((resolve, reject) => {
        finishCancellation = resolve
        cancelTimer = setTimeout(() => {
          try {
            signalGroup('SIGKILL')
            resolve()
          } catch (error) {
            reject(error)
          }
        }, 2000)
      })
    }
  }
  const onInt = () => stop('SIGINT')
  const onTerm = () => stop('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  let status
  try {
    child = spawn(process.execPath, vitestArgs, {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        HIVE_DATA_DIR: dataDir,
        HOME: testHome,
        USERPROFILE: testHome,
        LOCALAPPDATA: join(testHome, 'AppData', 'Local'),
        APPDATA: join(testHome, 'AppData', 'Roaming'),
        // Let each capture adapter resolve against the isolated home/XDG roots.
        HIVE_OPENCODE_DB_PATH: undefined,
        HIVE_GEMINI_HOME: undefined,
        HIVE_QWEN_HOME: undefined,
        CODEX_HOME: join(testHome, '.codex'),
        HIVE_CLAUDE_PROJECTS_DIR: join(testHome, '.claude', 'projects'),
        XDG_CONFIG_HOME: join(testHome, '.config'),
        XDG_DATA_HOME: join(testHome, '.local', 'share'),
      },
    })
    status = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    })
    if (cancellation) {
      try {
        process.kill(-child.pid, 0)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
        clearTimeout(cancelTimer)
        finishCancellation()
      }
      await cancellation
    }
  } finally {
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }

  if (interrupted) process.exit(interrupted === 'SIGINT' ? 130 : 143)
  if (status !== 0) process.exit(status ?? 1)
}

const isTestFile = (filePath) => /\.test\.[cm]?[jt]sx?$/u.test(filePath)

const collectTestFiles = (dir) => {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(childPath))
      continue
    }
    if (entry.isFile() && isTestFile(childPath)) {
      files.push(childPath.replaceAll('\\', '/'))
    }
  }
  return files
}

const chunk = (items, size) => {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

if (process.platform === 'win32' && passthrough.length === 0) {
  const chunks = chunk(collectTestFiles('tests').sort(), 10)
  for (const [index, filesChunk] of chunks.entries()) {
    console.log(`\n[hive] Windows full test chunk ${index + 1}/${chunks.length}`)
    await runVitest(filesChunk, stableFullSuiteVitestFlags)
  }
} else if (passthrough.length === 0) {
  await runVitest([], stableFullSuiteVitestFlags)
} else {
  await runVitest(passthrough)
}
