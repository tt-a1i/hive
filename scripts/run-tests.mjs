import { spawnSync } from 'node:child_process'
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

const runVitest = (filesOrArgs = [], extraArgs = []) => {
  const command =
    filesOrArgs[0] === '--related'
      ? ['related', '--run', ...filesOrArgs.slice(1)]
      : ['run', ...filesOrArgs]
  const vitestArgs = [vitestBin, ...command, ...extraArgs]

  // The test entry point must never inherit a user's live runtime database.
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-test-data-'))
  const testHome = join(dataDir, 'home')
  mkdirSync(testHome)
  let result
  try {
    result = spawnSync(process.execPath, vitestArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        HIVE_DATA_DIR: dataDir,
        HOME: testHome,
        USERPROFILE: testHome,
        CODEX_HOME: join(testHome, '.codex'),
        HIVE_CLAUDE_PROJECTS_DIR: join(testHome, '.claude', 'projects'),
        XDG_CONFIG_HOME: join(testHome, '.config'),
        XDG_DATA_HOME: join(testHome, '.local', 'share'),
      },
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
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
    runVitest(filesChunk, stableFullSuiteVitestFlags)
  }
} else if (passthrough.length === 0) {
  runVitest([], stableFullSuiteVitestFlags)
} else {
  runVitest(passthrough)
}
