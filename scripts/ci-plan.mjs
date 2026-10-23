import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const flags = [
  '--no-file-parallelism',
  '--maxWorkers=1',
  '--testTimeout=60000',
  '--hookTimeout=60000',
  '--exclude=tests/integration/package-tarball.test.ts',
]
// These scripts are invoked as subprocesses, so import-graph selection cannot find their tests.
const scriptTests = {
  'scripts/ci-plan.mjs': ['tests/unit/ci-plan.test.ts'],
  'scripts/run-tests.mjs': ['tests/unit/ci-plan.test.ts'],
  'scripts/ci-result.mjs': ['tests/unit/ci-plan.test.ts'],
  'scripts/prepare-build-artifacts.mjs': ['tests/unit/prepare-build-artifacts.test.js'],
  // Executed directly by the build or platform installation jobs.
  'scripts/clean-build.mjs': [],
  'scripts/pack-smoke.mjs': [],
}

if (process.argv[2] === '--run') {
  const inputs = JSON.parse(process.env.CI_TEST_INPUTS ?? '[]')
  if (!Array.isArray(inputs) || !inputs.every((input) => typeof input === 'string')) {
    throw new TypeError('CI_TEST_INPUTS must be an array of file paths')
  }
  const full = process.env.CI_FULL === 'true'
  const shard = process.env.CI_TEST_SHARD
  if (shard) {
    const match = /^(\d+)\/(\d+)$/u.exec(shard)
    const index = Number(match?.[1])
    const total = Number(match?.[2])
    if (!full || !Number.isSafeInteger(total) || index < 1 || index > total) {
      throw new Error('CI_TEST_SHARD must select a valid partition of the full suite')
    }
  }
  if (full || inputs.length) {
    const direct = inputs.every((file) => /\.test\.[jt]sx?$/u.test(file))
    const args = full
      ? [...flags, ...(shard ? [`--shard=${shard}`] : [])]
      : [...(direct ? [] : ['--related']), ...inputs, ...flags]
    const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', ...args], {
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } else {
    console.log('No backend/test changes: static checks and build cover this change.')
  }
} else {
  const forced = process.env.CI_FULL === 'true'
  const base = process.env.CI_BASE_SHA
  if (!forced && !/^[a-f0-9]{40}$/u.test(base ?? '')) {
    throw new Error('CI_BASE_SHA must identify the checked-out PR base commit')
  }
  const files = forced
    ? []
    : execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--'], {
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean)
  const docs = (file) =>
    /^(docs\/|README[^/]*$|CHANGELOG\.md$|AGENTS\.md$|CLAUDE\.md$|LICENSE[^/]*$|NOTICE$|TRADEMARK\.md$|SECURITY\.md$)/u.test(
      file
    )
  // Gateway is separately deployed and tested by Gateway Deploy; don't install the desktop app.
  const relevant = files.filter((file) => !docs(file) && !file.startsWith('gateway/'))
  let full = forced
  let native = forced
  for (const file of relevant) {
    if (file.startsWith('src/') && !existsSync(file)) full = true
    if (file.startsWith('scripts/') && !Object.hasOwn(scriptTests, file)) full = true
    if (file === '.github/workflows/ci.yml') full = true
    if (file === 'package.json') {
      const oldPackage = JSON.parse(
        execFileSync('git', ['show', `${base}:package.json`], { encoding: 'utf8' })
      )
      const newPackage = JSON.parse(readFileSync(file, 'utf8'))
      delete oldPackage.version
      delete newPackage.version
      if (JSON.stringify(oldPackage) !== JSON.stringify(newPackage)) full = native = true
    } else if (
      /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|tsconfig[^/]*|vitest\.config\.)/u.test(file)
    ) {
      full = native = true
    } else if (
      /^src\/(shared\/|cli\/team|server\/(sqlite|runtime-|agent-|dispatch-|workflow-|remote-|team-|controller-|report-outbox|message-|routes-(team|workflow|remote)))/u.test(
        file
      )
    ) {
      full = true
    }
    if (
      /^(scripts\/|\.github\/|src\/cli\/|src\/server\/(agent-|pty-|windows-|platform-|workspace-shell|session-capture|update-|package-version))/u.test(
        file
      )
    )
      native = true
    if (
      !/^(src\/|web\/|tests\/|scripts\/|\.github\/|assets\/|package\.json$|pnpm-|\.npmrc$|tsconfig|vitest\.config\.|biome\.json|\.gitignore$)/u.test(
        file
      )
    ) {
      // Unclassified build/runtime inputs must never silently lose coverage.
      full = native = true
    }
  }
  const inputs = relevant.filter((file) => /^(src\/|tests\/)/u.test(file) && existsSync(file))
  for (const file of relevant) inputs.push(...(scriptTests[file] ?? []))
  if (relevant.includes('package.json') || relevant.includes('web/src/whats-new/changelog.ts')) {
    inputs.push('tests/unit/whats-new-select.test.ts')
  }
  if (inputs.some((file) => file.startsWith('src/'))) {
    // CLI subprocess imports are invisible to Vitest's dependency graph.
    inputs.push('tests/cli/team-cli.test.ts', 'tests/server/runtime-rehydration.test.ts')
  }
  const plan = {
    code: forced || relevant.length > 0,
    full,
    native: native || full,
    extended: forced,
    legacy:
      full ||
      inputs.some((file) => file.startsWith('src/')) ||
      relevant.includes('tests/unit/sqlite.test.ts'),
    tests: full || inputs.length > 0,
    shards: full ? [1, 2, 3, 4] : [1],
    inputs: [...new Set(inputs)],
  }
  console.log(JSON.stringify({ ...plan, changed: files }, null, 2))
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(plan)) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(value)}\n`)
    }
  }
}
